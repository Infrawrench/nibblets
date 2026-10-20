// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { parseArgs } from "node:util";
import { startHostMcpBridge } from "./bridge.ts";
import { runOnHost } from "./clis/index.ts";
import { gitUpdater } from "./update.ts";

/**
 * Runs the host MCP bridge without the desktop app, for Linux and Windows
 * servers. Give the nibblet server the same token as HOST_MCP_TOKEN.
 *
 *   node packages/host-mcp/src/cli.ts --port 8789 --token <token> [--host <addr>] [--repo <dir>]
 *
 * With --repo (the checkout install.sh made), the server can ask it to
 * install a new release there.
 *
 * On Linux, containers can't reach the host's loopback; bind to the Docker
 * bridge address instead (usually 172.17.0.1) and set
 * HOST_MCP_URL=http://172.17.0.1:8789.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8789" },
    host: { type: "string", default: "127.0.0.1" },
    token: { type: "string", default: process.env.HOST_MCP_TOKEN ?? "" },
    repo: { type: "string" },
  },
});

if (!values.token) {
  console.error("usage: cli.ts --token <token> [--port 8789] [--host 127.0.0.1]");
  process.exit(2);
}

const bridge = await startHostMcpBridge({
  port: Number(values.port),
  host: values.host,
  token: values.token,
  log: (m) => console.log(m),
  ...(values.repo ? { updater: gitUpdater(values.repo, runOnHost) } : {}),
});
console.log(`host MCP bridge on ${values.host}:${bridge.port}`);

const stop = () => void bridge.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
