import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** A tiny stdio MCP server for tests and for checking the bridge by hand. */
const server = new McpServer({ name: "nibblet-test-echo", version: "0.1.0" });
server.registerTool(
  "echo",
  {
    description: "Echoes the text back, reversed, so it's clear the tool ran.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${[...text].reverse().join("")}` }],
  }),
);
await server.connect(new StdioServerTransport());
