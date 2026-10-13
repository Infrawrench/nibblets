import { describe, expect, it } from "vitest";
import { importMcpJson, slugify, upsertServers } from "./mcpImport.ts";

describe("importMcpJson", () => {
  it("reads Claude's mcpServers shape, both kinds", () => {
    const { servers, errors } = importMcpJson(
      JSON.stringify({
        mcpServers: {
          Linear: {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { authorization: "Bearer x" },
          },
          "Everything Server": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
          },
        },
      }),
    );
    expect(errors).toEqual([]);
    expect(servers).toEqual([
      {
        name: "linear",
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { authorization: "Bearer x" },
      },
      {
        name: "everything-server",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: {},
      },
    ]);
  });

  it("accepts the bare map and explains what it skipped", () => {
    const { servers, errors } = importMcpJson(
      JSON.stringify({
        ok: { command: "x" },
        nibblet: { command: "y" },
        old: { type: "sse", url: "https://a.dev/sse" },
      }),
    );
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(2);
  });

  it("rejects junk", () => {
    expect(importMcpJson("nope").errors).toEqual(["That isn't valid JSON"]);
  });
});

describe("helpers", () => {
  it("slugifies names", () => {
    expect(slugify("My GitHub!")).toBe("my-github");
  });
  it("upserts by name", () => {
    const a = { name: "a", type: "stdio" as const, command: "1", args: [], env: {} };
    expect(upsertServers([a], [{ ...a, command: "2" }])).toEqual([{ ...a, command: "2" }]);
  });
});
