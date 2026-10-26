/**
 * The guard: the part of a nibblet's container that holds secrets, run by
 * the container's entry as its own user so the agent (another user) can't
 * read its memory, environment or files. It runs the browser
 * (OpenComputerUse), and the gate in front of the browser, 1Password, the
 * nibblet's own MCP servers and its app links' tools, which it starts
 * itself with their secrets. Its
 * settings come from the server with its own token, and "ask me first"
 * calls wait on the server, so neither depends on anything the agent can
 * reach.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "@nibblets/harness";
import {
  GATE_PORT,
  GuardConfig,
  GuardEnv,
  type GuardAppView,
  ONEPASSWORD_VAULTS_ENV,
  type JsonValue,
  type ToolRule,
} from "@nibblets/protocol";
import { z } from "zod";
import { clearProfileLock, startComputer, type Computer } from "./computer.ts";
import { McpGate, type Decision } from "./gate.ts";

const log = (message: string) => console.warn(`guard: ${message}`);

/** An error's message, with its causes': fetch only says "fetch failed", and the cause says why. */
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Connecting to several addresses fails with an AggregateError that has only a code.
  const message = err.message || ("code" in err ? String(err.code) : err.name);
  return err.cause instanceof Error ? `${message} (${reason(err.cause)})` : message;
}

const Answer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting"), approvalId: z.string() }),
  z.object({ status: z.literal("decided"), approved: z.boolean(), reason: z.string().nullable() }),
]);

/** Talking to the server as this nibblet's guard. */
export function guardClient(env: GuardEnv, fetcher: typeof fetch = fetch) {
  const auth = { authorization: `Bearer ${env.NIBBLET_GUARD_TOKEN}` };
  const base = `${env.NIBBLET_SERVER_URL}/guard/${encodeURIComponent(env.NIBBLET_ID)}`;
  return {
    async config(): Promise<GuardConfig> {
      const res = await fetcher(`${base}/config`, {
        headers: auth,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
      return GuardConfig.parse(await res.json());
    },
    /** Hands the server a call of a tool with an MCP App view, for the thread. */
    async view(report: GuardAppView): Promise<void> {
      const res = await fetcher(`${base}/view`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
    },
    /** Asks the person, through the server, polling until they decide. */
    async ask(server: string, tool: string, input: JsonValue): Promise<Decision> {
      let res = await fetcher(`${base}/approval`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ server, tool, input }),
      });
      for (;;) {
        if (!res.ok) {
          return { approved: false, reason: `Couldn't ask (the server said ${res.status})` };
        }
        const answer = Answer.parse(await res.json());
        if (answer.status === "decided")
          return { approved: answer.approved, reason: answer.reason };
        res = await fetcher(`${base}/approval/${encodeURIComponent(answer.approvalId)}`, {
          headers: auth,
        });
      }
    },
  };
}

/** The specs behind the gate, from the settings and what's running here. */
export function gatedSpecs(
  config: GuardConfig,
  browser: McpServerSpec | null,
  onePasswordScript: string,
): Record<string, McpServerSpec> {
  const specs: Record<string, McpServerSpec> = {};
  if (browser) specs.computer = browser;
  if (config.onePassword) {
    const browserEnv: Record<string, string> =
      browser?.type === "http"
        ? {
            OCU_MCP_URL: browser.url,
            ...(browser.headers.authorization
              ? { OCU_MCP_AUTH: browser.headers.authorization }
              : {}),
          }
        : {};
    specs.onepassword = {
      type: "stdio",
      command: process.execPath,
      args: [onePasswordScript],
      env: {
        OP_SERVICE_ACCOUNT_TOKEN: config.onePassword.token,
        [ONEPASSWORD_VAULTS_ENV]: JSON.stringify(config.onePassword.vaults),
        ...browserEnv,
      },
    };
  }
  for (const server of config.mcpServers) {
    specs[server.name] =
      server.type === "http"
        ? { type: "http", url: server.url, headers: server.headers }
        : { type: "stdio", command: server.command, args: server.args, env: server.env };
  }
  // An app link's tools take the name over from its own server, as the server already does.
  for (const app of config.appLinks) {
    specs[app.name] = { type: "http", url: app.url, headers: app.headers };
  }
  return specs;
}

const onePasswordScript = fileURLToPath(new URL("./onepassword-mcp.ts", import.meta.url));

async function main(): Promise<void> {
  const env = GuardEnv.parse(process.env);
  const server = guardClient(env);
  let rules: readonly ToolRule[] = [];
  let computer: Computer | null = null;

  const apply = async () => {
    const config = await server.config();
    rules = config.toolApprovals;
    gate.sync(gatedSpecs(config, computer?.mcp ?? null, onePasswordScript));
  };
  const gate = new McpGate({
    ask: (name, tool, input) => server.ask(name, tool, input),
    view: (report) => server.view(report),
    rules: () => rules,
    log,
    port: env.NIBBLET_GATE_PORT ?? GATE_PORT,
    onRefresh: () => apply().catch((err: unknown) => log(`couldn't refresh: ${reason(err)}`)),
  });

  // The browser keeps its profile and downloads under the guard's own home.
  if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
  if (env.NIBBLET_BROWSER === "1") {
    if (!env.NIBBLET_VIEW_TOKEN)
      log("NIBBLET_VIEW_TOKEN is empty; the browser view is unprotected");
    if (process.env.HOME) {
      await clearProfileLock(process.env.HOME).catch((err: unknown) =>
        log(`couldn't clear the browser's profile lock: ${reason(err)}`),
      );
    }
    computer = await startComputer(
      env.NIBBLET_VIEW_TOKEN,
      (_level, message) => log(message),
      env.NIBBLET_BROWSER_PORT && env.NIBBLET_VIEW_PORT
        ? { mcp: env.NIBBLET_BROWSER_PORT, view: env.NIBBLET_VIEW_PORT }
        : undefined,
    );
  }
  // Settings first, so the gate never answers with half of them.
  for (let attempt = 1; ; attempt++) {
    try {
      await apply();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`waiting for the server: ${reason(err)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await gate.start();
  console.log(`guard: gate on 127.0.0.1:${env.NIBBLET_GATE_PORT ?? GATE_PORT}`);

  const shutdown = async () => {
    await gate.close().catch(() => {});
    computer?.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`guard: ${reason(err)}`);
    process.exit(1);
  });
}
