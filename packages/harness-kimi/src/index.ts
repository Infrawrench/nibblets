import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  defineHarness,
  inputWithAttachments,
  installedCliDir,
  type HarnessContext,
  type TurnRequest,
} from "@nibblets/harness";
import { harnesses, KimiLine } from "@nibblets/protocol";
import { installLogin, kimiConfig, writeMcpConfig } from "./login.ts";
import { KimiMapper } from "./mapper.ts";

export { KimiMapper, parseArguments } from "./mapper.ts";
export * from "./login.ts";

const require = createRequire(import.meta.url);
const PACKAGE = "@moonshot-ai/kimi-code";

/** The CLI npm ships, as `{ dir, version, bin }` from its package.json. */
export function cliPackage(): { dir: string; version: string; bin: string } {
  const file = require.resolve(`${PACKAGE}/package.json`);
  const pkg: { version?: string; bin?: string | Record<string, string> } = require(
    `${PACKAGE}/package.json`,
  );
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.kimi ?? "dist/main.mjs");
  return { dir: path.dirname(file), version: pkg.version ?? "unknown", bin };
}

/**
 * The CLI to run: a newer one the server installed for runners, else the one
 * this package depends on. Resolved to a real file each turn, so an update
 * lands on the next turn rather than swapping the binary mid-run.
 */
export function resolveCli(): string {
  const dir = installedCliDir("kimi");
  if (dir) return path.join(dir, "kimi");
  const { dir: pkgDir, bin } = cliPackage();
  return path.join(pkgDir, bin);
}

/** Where the token and config go: the container's /tmp, never the home volume. */
const KIMI_SECRETS = path.join(os.tmpdir(), "nibblet-secrets");

/**
 * Kimi Code CLI takes no system prompt in print mode, so the turn's
 * instructions ride along with the input. Its `ReadMediaFile` tool reads the
 * attachments by the paths `inputWithAttachments` names.
 */
export function promptFor(turn: TurnRequest): string {
  const input = inputWithAttachments(turn.input, turn.attachments);
  const system = turn.system.trim();
  return system ? `${system}\n\n${input}` : input;
}

/** The effort levels Kimi takes for `model`; none for a model that has no setting. */
function effortsFor(model: string) {
  return harnesses.kimi.models.find((m) => m.id === model)?.efforts ?? [];
}

/**
 * Writes the Kimi home a nibblet runs in: the host's own config and login
 * under a private home, plus the MCP servers the nibblet brings. Throws when
 * the host has no login to share, since Kimi Code has no other way in.
 */
export async function prepareHome(ctx: HarnessContext): Promise<string> {
  const login = ctx.config.hostLogin;
  if (!login?.secret) {
    throw new Error(
      "Kimi Code needs a login: run `kimi login` on this machine, or pick another harness.",
    );
  }
  const config = kimiConfig(
    { config: login.config, token: login.secret },
    ctx.config.effort,
    effortsFor(ctx.config.model),
  );
  const home = path.join(ctx.stateDir ?? ctx.workdir, ".kimi-code");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeMcpConfig(home, ctx.mcpServers);
  await installLogin(home, login.secret, config, KIMI_SECRETS);
  return home;
}

/** The argv one turn runs, which is what the CLI documents for print mode. */
export function turnArgs(input: string, model: string, sessionId: string | null): string[] {
  const args = ["-p", input, "--output-format", "stream-json"];
  if (model) args.push("-m", model);
  if (sessionId) args.push("--session", sessionId);
  return args;
}

/**
 * Why a turn failed. Kimi reports it on stderr as `error: <reason>`, and
 * follows it with a pointer to a log file, which says nothing useful.
 */
export function failureFrom(stderr: string, code: number | null): string {
  const reason = stderr.split("\n").find((line) => line.startsWith("error:"));
  if (reason) return reason.slice("error:".length).trim();
  const last = stderr.trim().split("\n").pop();
  return last || `kimi exited with code ${code}`;
}

export const kimiHarness = defineHarness({
  id: "kimi",
  version: () => `kimi ${cliPackage().version}`,
  bundledCli: () => cliPackage().version,
  async open(ctx) {
    const home = await prepareHome(ctx);
    let sessionId = ctx.config.resumeSessionId;

    return {
      async run(turn, out) {
        const cli = resolveCli();
        const mapper = new KimiMapper(out);
        const args = turnArgs(promptFor(turn), ctx.config.model, sessionId);
        ctx.log("debug", `kimi -p (model ${ctx.config.model || "default"}, resume ${sessionId})`);

        const child = spawn(cli, args, {
          cwd: ctx.workdir,
          // The kimi home sits in the workdir, where Kimi also looks for a
          // project's own MCP servers, so it only loads them once the folder
          // is trusted. The container is the sandbox; the workdir is ours.
          // A sub-agent's home is elsewhere, and the workdir's is its
          // parent's, with the parent's token: that one stays untrusted.
          env: {
            ...process.env,
            KIMI_CODE_HOME: home,
            ...(ctx.stateDir ? {} : { KIMI_CODE_TRUST_WORKSPACE: "1" }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stderr: string[] = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
          stderr.push(text);
          ctx.log("debug", text.trimEnd());
        });
        const reader = createInterface({ input: child.stdout });
        reader.on("line", (line) => {
          if (!line.trim()) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }
          const known = KimiLine.safeParse(parsed);
          if (known.success) mapper.handle(known.data);
        });
        const onAbort = () => child.kill("SIGTERM");
        turn.signal.addEventListener("abort", onAbort, { once: true });

        let code: number | null = null;
        try {
          code = await new Promise<number | null>((resolve) => {
            child.on("error", (err) => {
              mapper.state.error = err.message;
              resolve(null);
            });
            child.on("close", (closed) => resolve(closed));
          });
        } finally {
          turn.signal.removeEventListener("abort", onAbort);
          reader.close();
          out.finish();
        }

        sessionId = mapper.state.sessionId ?? sessionId;
        if (!turn.signal.aborted && code !== 0) {
          mapper.state.error ??= failureFrom(stderr.join(""), code);
        }
        const status = turn.signal.aborted
          ? "interrupted"
          : mapper.state.error
            ? "failed"
            : "completed";
        return {
          status,
          error:
            status === "failed" ? (mapper.state.error ?? "Kimi exited without a result") : null,
          // stream-json carries no token counts.
          usage: null,
          sessionId,
        };
      },
      async close() {},
    };
  },
});

export default kimiHarness;
