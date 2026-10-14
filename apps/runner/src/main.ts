import { mkdir } from "node:fs/promises";
import type { McpServerSpec } from "@nibblet/harness";
import { GATE_PORT, RunnerEnv } from "@nibblet/protocol";
import { Connection } from "./connection.ts";
import { RunnerFiles } from "./files.ts";
import { plugins } from "./plugins.ts";
import { Runner } from "./runner.ts";

const env = RunnerEnv.parse(process.env);
const workdir = process.env.NIBBLET_WORKDIR ?? process.cwd();
await mkdir(workdir, { recursive: true });

const mcpServers: Record<string, McpServerSpec> = {
  nibblet: {
    type: "http",
    url: env.NIBBLET_MCP_URL,
    headers: { authorization: `Bearer ${env.NIBBLET_TOKEN}` },
  },
};

let connection: Connection | null = null;
const log = (level: "info" | "warn", message: string) => {
  console[level === "info" ? "log" : "warn"](`runner: ${message}`);
  connection?.send({ type: "log", level, message });
};

// Attachments come down before a turn; `share_file` sends files up.
const files = new RunnerFiles({
  serverUrl: env.NIBBLET_MCP_URL.replace(/\/mcp\/?$/, ""),
  token: env.NIBBLET_TOKEN,
  workdir,
  currentTurn: () => runner.currentTurnId(),
});
mcpServers.files = await files.startMcp();

// `/mcp` and `/hostmcp/<name>` live side by side on the nibblet server.
const hostMcpBase = env.NIBBLET_MCP_URL.replace(/\/mcp\/?$/, "/hostmcp");

// The browser, 1Password and its own MCP servers sit behind the guard's
// gate, run as another user; this process only knows their addresses.
const gateBase = `http://127.0.0.1:${GATE_PORT}`;

const runner: Runner = new Runner({
  plugins,
  send: (msg) => connection?.send(msg),
  workdir,
  mcpServers,
  hostMcp: (name) => ({
    type: "http",
    url: `${hostMcpBase}/${encodeURIComponent(name)}`,
    headers: { authorization: `Bearer ${env.NIBBLET_TOKEN}` },
  }),
  credproxyUrl: env.NIBBLET_CREDPROXY_URL,
  credproxyKey: env.NIBBLET_CREDPROXY_KEY,
  gateUrl: (name) => `${gateBase}/mcp/${encodeURIComponent(name)}`,
  refreshGuard: async () => {
    await fetch(`${gateBase}/refresh`, { method: "POST", signal: AbortSignal.timeout(30_000) });
  },
  files,
});

connection = new Connection({
  url: env.NIBBLET_SERVER_WS,
  token: env.NIBBLET_TOKEN,
  onMessage: (msg) => runner.handle(msg),
  onOpen: () => {
    const versions = Object.values(plugins).map((p) => p.version());
    connection?.send({ type: "ready", harnessVersion: versions.join(", ") });
  },
});
connection.connect();
console.log(`runner: nibblet ${env.NIBBLET_ID} connecting to ${env.NIBBLET_SERVER_WS}`);

async function shutdown(): Promise<void> {
  connection?.close();
  await runner.close().catch(() => {});
  await files.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
