import { mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config,
  type McpLocalConfig,
  type McpRemoteConfig,
} from "@opencode-ai/sdk";
import { defineHarness, type HarnessContext, type McpServerSpec } from "@nibblet/harness";
import type { Usage } from "@nibblet/protocol";
import { OpencodeMapper } from "./mapper.ts";

export { OpencodeMapper } from "./mapper.ts";

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
 * Both providers point at the credential proxy with the proxy key as their
 * API key: Anthropic sends it as `x-api-key`, OpenAI as a bearer token.
 */
export function opencodeConfig(ctx: HarnessContext): Config {
  return {
    model: ctx.config.model,
    autoupdate: false,
    share: "disabled",
    provider: {
      anthropic: {
        options: { baseURL: `${ctx.credproxyUrl}/anthropic/v1`, apiKey: ctx.credproxyKey },
      },
      openai: {
        options: { baseURL: `${ctx.credproxyUrl}/openai`, apiKey: ctx.credproxyKey },
      },
    },
    enabled_providers: ["anthropic", "openai"],
    mcp: Object.fromEntries(Object.entries(ctx.mcpServers).map(([n, s]) => [n, mcpFor(s)])),
    // The container is the sandbox; nobody is there to approve prompts.
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  };
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash < 0) return { providerID: "anthropic", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export const opencodeHarness = defineHarness({
  id: "opencode",
  version: () => `opencode ${cliPackage().version}`,
  async open(ctx) {
    const home = path.join(ctx.workdir, ".opencode");
    await mkdir(home, { recursive: true });
    // createOpencodeServer spawns `opencode` from PATH with the parent's env,
    // and the package ships its binary as `bin/opencode.exe`, so link it in.
    const bin = path.join(home, "bin");
    await mkdir(bin, { recursive: true });
    await rm(path.join(bin, "opencode"), { force: true });
    await symlink(path.join(cliPackage().dir, "bin", "opencode.exe"), path.join(bin, "opencode"));
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    process.env.XDG_STATE_HOME = path.join(home, "state");
    process.env.XDG_CACHE_HOME = path.join(home, "cache");

    const server = await createOpencodeServer({
      port: await freePort(),
      timeout: 30_000,
      config: opencodeConfig(ctx),
    });
    const client = createOpencodeClient({ baseUrl: server.url, directory: ctx.workdir });

    let sessionId = ctx.config.resumeSessionId;
    if (sessionId) {
      const existing = await client.session.get({ path: { id: sessionId } });
      if (!existing.data) sessionId = null;
    }

    return {
      async run(turn, out) {
        if (!sessionId) {
          const created = await client.session.create({ body: { title: ctx.config.name } });
          if (!created.data) throw new Error("OpenCode could not create a session");
          sessionId = created.data.id;
        }
        const id = sessionId;
        const mapper = new OpencodeMapper(out, id);
        const events = await client.event.subscribe();
        const pump = (async () => {
          for await (const event of events.stream) {
            mapper.handle(event);
            if (mapper.idle) break;
          }
        })();
        const onAbort = () => void client.session.abort({ path: { id } });
        turn.signal.addEventListener("abort", onAbort, { once: true });

        let usage: Usage | null = null;
        try {
          const res = await client.session.prompt({
            path: { id },
            body: {
              model: splitModel(ctx.config.model),
              system: turn.system,
              parts: [{ type: "text", text: turn.input }],
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
        server.close();
      },
    };
  },
});

export default opencodeHarness;
