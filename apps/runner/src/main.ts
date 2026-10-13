import { mkdir } from "node:fs/promises";
import { claudeHarness } from "@nibblet/harness-claude";
import { codexHarness } from "@nibblet/harness-codex";
import { opencodeHarness } from "@nibblet/harness-opencode";
import type { McpServerSpec } from "@nibblet/harness";
import { RunnerEnv } from "@nibblet/protocol";
import { startComputer, type Computer } from "./computer.ts";
import { Connection } from "./connection.ts";
import { Runner } from "./runner.ts";

const env = RunnerEnv.parse(process.env);
const workdir = process.env.NIBBLET_WORKDIR ?? process.cwd();
await mkdir(workdir, { recursive: true });

const plugins = { claude: claudeHarness, codex: codexHarness, opencode: opencodeHarness };

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

// `/mcp` and `/hostmcp/<name>` live side by side on the nibblet server.
const hostMcpBase = env.NIBBLET_MCP_URL.replace(/\/mcp\/?$/, "/hostmcp");

const runner = new Runner({
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
  computer?.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
