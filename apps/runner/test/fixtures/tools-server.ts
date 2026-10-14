import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** A tiny MCP server with a harmless tool and a risky-looking one, for the gate's tests. */
export function toolsServer(): McpServer {
  const server = new McpServer({ name: "nibblet-test-tools", version: "0.1.0" });
  server.registerTool(
    "echo",
    { description: "Echoes text back.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "send_money",
    { description: "Pretends to send money.", inputSchema: { amount: z.number() } },
    async ({ amount }) => ({ content: [{ type: "text", text: `sent ${amount}` }] }),
  );
  return server;
}

if (process.argv[2] === "stdio") await toolsServer().connect(new StdioServerTransport());
