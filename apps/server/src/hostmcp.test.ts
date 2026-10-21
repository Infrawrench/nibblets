import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { HostTool, McpServerDef } from "@nibblets/protocol";
import { dropOverlaps, hostToolAllowed } from "./hostmcp.ts";

describe("hostToolAllowed", () => {
  it("only allows servers ticked for the nibblet", () => {
    expect(hostToolAllowed(["files", "linear"], "files")).toBe(true);
    expect(hostToolAllowed(["files"], "linear")).toBe(false);
    expect(hostToolAllowed([], "files")).toBe(false);
  });
});

describe("dropOverlaps", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const host: HostTool[] = [
    {
      name: "linear",
      source: "Claude Code",
      transport: "http",
      status: "idle",
      detail: null,
      tools: [],
      fingerprint: sha("https://mcp.linear.app/mcp"),
    },
    {
      name: "fs",
      source: "Claude Desktop",
      transport: "stdio",
      status: "idle",
      detail: null,
      tools: [],
      fingerprint: sha("npx -y @modelcontextprotocol/server-filesystem /tmp"),
    },
  ];
  const own: McpServerDef[] = [
    { name: "linear", type: "http", url: "https://example.com/other", headers: {} },
    { name: "my-linear", type: "http", url: "https://mcp.linear.app/mcp/", headers: {} },
    {
      name: "files",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: {},
    },
    { name: "keep", type: "http", url: "https://mcp.example.com", headers: {} },
  ];

  it("drops a nibblet's own servers that duplicate host tools it has ticked", () => {
    expect(dropOverlaps(own, ["linear", "fs"], host).map((s) => s.name)).toEqual(["keep"]);
  });

  it("leaves them alone when the host tool isn't ticked", () => {
    expect(dropOverlaps(own, [], host)).toHaveLength(4);
    expect(dropOverlaps(own, ["fs"], host).map((s) => s.name)).toEqual([
      "linear",
      "my-linear",
      "keep",
    ]);
  });
});
