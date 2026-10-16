import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerSpec } from "@nibblet/harness";
import { createServer } from "node:http";

/** A tool's answer: what `work` returns, or what it threw, as an error the model can read. */
export async function toolReply(work: () => Promise<string> | string) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

/**
 * One of the runner's own MCP servers (`files`, `tasks`, `apps`), for its
 * harness: stateless, with a fresh server per request, on a port of its own
 * on loopback.
 */
export async function serveMcp(
  name: string,
  register: (server: McpServer) => void,
): Promise<{ spec: McpServerSpec; close(): Promise<void> }> {
  const http = createServer((req, res) => {
    const server = new McpServer({ name, version: "0.1.0" });
    register(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", () => done()));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    spec: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} },
    close: () => new Promise<void>((done) => http.close(() => done())),
  };
}
