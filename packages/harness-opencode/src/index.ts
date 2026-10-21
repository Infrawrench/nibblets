import os from "node:os";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type McpLocalConfig,
  type McpRemoteConfig,
} from "@opencode-ai/sdk";
import {
  defineHarness,
  inputWithAttachments,
  isModelImage,
  type HarnessContext,
  type McpServerSpec,
  installedCliDir,
} from "@nibblets/harness";
import type { Usage } from "@nibblets/protocol";
import { installLogin, type OpencodeDirs } from "./login.ts";
import { OpencodeMapper } from "./mapper.ts";

export { OpencodeMapper } from "./mapper.ts";
export * from "./login.ts";

const require = createRequire(import.meta.url);

/** `opencode-ai` has no `exports`, so its package.json resolves directly. */
function cliPackage(): { dir: string; version: string } {
  const file = require.resolve("opencode-ai/package.json");
  const pkg: { version?: string } = require("opencode-ai/package.json");
  return { dir: path.dirname(file), version: pkg.version ?? "unknown" };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function mcpFor(spec: McpServerSpec): McpLocalConfig | McpRemoteConfig {
  if (spec.type === "http")
    return { type: "remote", url: spec.url, headers: spec.headers, oauth: false };
  return { type: "local", command: [spec.command, ...spec.args], environment: spec.env };
}

/**
 * With the host's OpenCode login, providers come from the user's own config
 * (written to the container's XDG config dir), so this only adds what the
 * nibblet brings. Without one, Anthropic and OpenAI go through the
 * credential proxy with the proxy key as their API key: Anthropic sends it
 * as `x-api-key`, OpenAI as a bearer token.
 */
export function opencodeConfig(ctx: HarnessContext): Config {
  const own: Config = {
    model: ctx.config.model,
    autoupdate: false,
    share: "disabled",
    mcp: Object.fromEntries(Object.entries(ctx.mcpServers).map(([n, s]) => [n, mcpFor(s)])),
    // The container is the sandbox; nobody is there to approve prompts.
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  };
  if (ctx.config.hostLogin) return own;
  return {
    ...own,
    provider: {
      anthropic: {
        options: { baseURL: `${ctx.credproxyUrl}/anthropic/v1`, apiKey: ctx.credproxyKey },
      },
      openai: {
        options: { baseURL: `${ctx.credproxyUrl}/openai`, apiKey: ctx.credproxyKey },
      },
    },
    enabled_providers: ["anthropic", "openai"],
  };
}

/**
 * Points this process at a private OpenCode home: the CLI on PATH (the
 * package ships it as `bin/opencode.exe`) and XDG directories under `home`.
 */
export async function prepareHome(home: string): Promise<OpencodeDirs> {
  const bin = path.join(home, "bin");
  await mkdir(bin, { recursive: true });
  await rm(path.join(bin, "opencode"), { force: true });
  await symlink(path.join(cliPackage().dir, "bin", "opencode.exe"), path.join(bin, "opencode"));
  const dirs = { config: path.join(home, "config"), data: path.join(home, "data") };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.XDG_DATA_HOME = dirs.data;
  process.env.XDG_CONFIG_HOME = dirs.config;
  process.env.XDG_STATE_HOME = path.join(home, "state");
  process.env.XDG_CACHE_HOME = path.join(home, "cache");
  return dirs;
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { providerID: "anthropic", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Fetches models.dev before OpenCode starts. A fresh container otherwise
 * starts on the CLI's built-in snapshot, and a model that's newer than it
 * fails until the background refresh lands.
 */
async function warmModelsCache(warn: (message: string) => void): Promise<void> {
  await new Promise<void>((resolve) =>
    execFile("opencode", ["models", "--refresh"], { timeout: 30_000 }, (err) => {
      if (err) warn(`Couldn't refresh OpenCode's model list: ${err.message}`);
      resolve();
    }),
  );
}

/** Where the provider token goes: the container's /tmp, never the home volume. */
const OPENCODE_SECRETS = path.join(os.tmpdir(), "nibblet-secrets");

/** PATH as the runner started, before any installed OpenCode was put ahead of it. */
const BASE_PATH = process.env.PATH ?? "";

export const opencodeHarness = defineHarness({
  id: "opencode",
  version: () => `opencode ${cliPackage().version}`,
  bundledCli: () => cliPackage().version,
  async open(ctx) {
    // createOpencodeServer spawns `opencode` from PATH with the parent's env.
    const home = path.join(ctx.stateDir ?? ctx.workdir, ".opencode");
    const dirs = await prepareHome(home);
    // The token lives outside the home volume, in the container's own /tmp.
    const host = ctx.config.hostLogin;
    if (host) {
      await installLogin(dirs, { config: host.config, auth: host.secret }, OPENCODE_SECRETS);
    }
    await warmModelsCache((m) => ctx.log("warn", m));

    // A newer OpenCode the server installed goes first on PATH, then the
    // bundled one prepareHome linked. When another arrives, the next turn
    // starts a fresh server on it; sessions live on disk.
    const start = async () => {
      const dir = installedCliDir("opencode");
      process.env.PATH = [...(dir ? [dir] : []), path.join(home, "bin"), BASE_PATH].join(
        path.delimiter,
      );
      const server = await createOpencodeServer({
        port: await freePort(),
        timeout: 30_000,
        config: opencodeConfig(ctx),
      });
      return {
        dir,
        server,
        client: createOpencodeClient({ baseUrl: server.url, directory: ctx.workdir }),
      };
    };
    let live = await start();

    let sessionId = ctx.config.resumeSessionId;
    if (sessionId) {
      const existing = await live.client.session.get({ path: { id: sessionId } });
      if (!existing.data) sessionId = null;
    }

    return {
      async run(turn, out) {
        if (installedCliDir("opencode") !== live.dir) {
          live.server.close();
          live = await start();
        }
        if (!sessionId) {
          const created = await live.client.session.create({ body: { title: ctx.config.name } });
          if (!created.data) throw new Error("OpenCode could not create a session");
          sessionId = created.data.id;
        }
        const id = sessionId;
        const mapper = new OpencodeMapper(out, id);
        const events = await live.client.event.subscribe();
        const pump = (async () => {
          for await (const event of events.stream) {
            mapper.handle(event);
            if (mapper.idle) break;
          }
        })();
        const onAbort = () => void live.client.session.abort({ path: { id } });
        turn.signal.addEventListener("abort", onAbort, { once: true });

        let usage: Usage | null = null;
        try {
          const res = await live.client.session.prompt({
            path: { id },
            body: {
              model: splitModel(ctx.config.model),
              system: turn.system,
              parts: [
                { type: "text", text: inputWithAttachments(turn.input, turn.attachments) },
                // Images as file parts the model can see; other files by path in the text.
                ...(turn.attachments ?? [])
                  .filter((a) => isModelImage(a.mime))
                  .map((a) => ({
                    type: "file" as const,
                    mime: a.mime,
                    filename: a.name,
                    url: pathToFileURL(a.path).href,
                  })),
              ],
            },
          });
          if (res.data) {
            const t = res.data.info.tokens;
            usage = {
              inputTokens: t.input + t.cache.read,
              outputTokens: t.output,
              cachedInputTokens: t.cache.read,
            };
            const failure = res.data.info.error;
            if (failure) {
              const message =
                failure.data && "message" in failure.data ? failure.data.message : null;
              mapper.error = typeof message === "string" ? message : failure.name;
            }
            // Parts that finished before the event stream caught up.
            for (const part of res.data.parts) {
              mapper.handle({ type: "message.part.updated", properties: { part } });
            }
          } else if (!turn.signal.aborted) {
            mapper.error = "OpenCode did not answer the prompt";
          }
        } catch (err) {
          if (!turn.signal.aborted) mapper.error = err instanceof Error ? err.message : String(err);
        } finally {
          turn.signal.removeEventListener("abort", onAbort);
          await Promise.race([pump, new Promise((r) => setTimeout(r, 1000))]);
          out.finish();
        }

        const status = turn.signal.aborted ? "interrupted" : mapper.error ? "failed" : "completed";
        return { status, error: status === "failed" ? mapper.error : null, usage, sessionId: id };
      },
      async close() {
        live.server.close();
      },
    };
  },
});

export default opencodeHarness;
