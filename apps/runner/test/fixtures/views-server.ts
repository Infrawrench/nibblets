import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_VIEW_MIME } from "@nibblets/protocol";
import { z } from "zod";

export const FARES_VIEW = "<!doctype html><p>Fares</p>";

/**
 * An MCP server with MCP App views, for the gate's tests: a tool with a
 * view, one only its view may call, and one whose view isn't an app.
 */
export function viewsServer(): McpServer {
  const server = new McpServer({ name: "nibblet-test-views", version: "0.1.0" });
  server.registerResource(
    "fares",
    "ui://fares/view.html",
    { mimeType: APP_VIEW_MIME },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: APP_VIEW_MIME,
          text: FARES_VIEW,
          _meta: {
            ui: { csp: { connectDomains: ["https://api.fares.test"] }, prefersBorder: false },
          },
        },
      ],
    }),
  );
  server.registerResource(
    "plain",
    "ui://plain/page.html",
    { mimeType: "text/html" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/html", text: "<p>no</p>" }] }),
  );
  server.registerTool(
    "search_fares",
    {
      description: "Finds fares.",
      inputSchema: { to: z.string() },
      _meta: { ui: { resourceUri: "ui://fares/view.html" } },
    },
    async ({ to }) => ({
      content: [{ type: "text", text: `fares to ${to}` }],
      structuredContent: { fares: [{ to, price: 96 }] },
    }),
  );
  server.registerTool(
    "hold_fare",
    {
      description: "Holds a fare, from the view.",
      inputSchema: { flight: z.string() },
      _meta: { ui: { resourceUri: "ui://fares/view.html", visibility: ["app"] } },
    },
    async ({ flight }) => ({ content: [{ type: "text", text: `held ${flight}` }] }),
  );
  server.registerTool(
    "plain_page",
    {
      description: "Has a view that isn't an MCP App.",
      _meta: { "ui/resourceUri": "ui://plain/page.html" },
    },
    async () => ({ content: [{ type: "text", text: "plain" }] }),
  );
  return server;
}

if (process.argv[2] === "stdio") await viewsServer().connect(new StdioServerTransport());
