import { mkdir } from "node:fs/promises";
import type { McpServerSpec } from "@nibblet/harness";
import { RunnerEnv } from "@nibblet/protocol";
import { startComputer, type Computer } from "./computer.ts";
import { Connection } from "./connection.ts";
import { RunnerFiles } from "./files.ts";
import { McpGate } from "./gate.ts";
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

let computer: Computer | null = null;
if (env.NIBBLET_BROWSER === "1") {
  if (!env.NIBBLET_VIEW_TOKEN)
    log("warn", "NIBBLET_VIEW_TOKEN is empty; the browser view is unprotected");
  computer = await startComputer(env.NIBBLET_VIEW_TOKEN, log);
  mcpServers.computer = computer.mcp;
}

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

// Its own MCP servers and the browser sit behind a local gate that holds
// "ask me first" calls; the runner asks the user through the server.
const gate = new McpGate({
  ask: (server, tool, input) => runner.ask(server, tool, input),
  rules: () => runner.rules(),
  log: (message) => log("warn", message),
});
await gate.start();

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
  gate,
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
  await gate.close().catch(() => {});
  await files.close().catch(() => {});
  computer?.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
