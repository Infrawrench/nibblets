import { describe, expect, it } from "vitest";
import {
  MASKED,
  McpServerList,
  maskMcpServers,
  mergeMcpServers,
  type McpServerDef,
} from "./mcp.ts";

const stored: McpServerDef[] = [
  {
    name: "linear",
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { authorization: "Bearer real" },
  },
  {
    name: "github",
    type: "stdio",
    command: "npx",
    args: ["-y", "gh-mcp"],
    env: { TOKEN: "ghp_real", ORG: "acme" },
  },
];

describe("McpServerList", () => {
  it("rejects reserved, host_ and duplicate names", () => {
    const one = (name: string) => ({ name, type: "stdio", command: "x" });
    expect(McpServerList.safeParse([one("nibblet")]).success).toBe(false);
    expect(McpServerList.safeParse([one("computer")]).success).toBe(false);
    expect(McpServerList.safeParse([one("host_files")]).success).toBe(false);
    expect(McpServerList.safeParse([one("Bad Name")]).success).toBe(false);
    expect(McpServerList.safeParse([one("a"), one("a")]).success).toBe(false);
    expect(McpServerList.safeParse([one("files"), one("web-search_2")]).success).toBe(true);
  });
});

describe("masking", () => {
  it("hides every header and env value but keeps the keys", () => {
    const masked = maskMcpServers(stored);
    expect(masked[0]).toMatchObject({ headers: { authorization: MASKED } });
    expect(masked[1]).toMatchObject({
      env: { TOKEN: MASKED, ORG: MASKED },
      args: ["-y", "gh-mcp"],
    });
  });

  it("round-trips an unchanged masked view back to the stored secrets", () => {
    expect(mergeMcpServers(maskMcpServers(stored), stored)).toEqual(stored);
  });

  it("replaces changed values, drops removed keys, and drops masks with nothing behind them", () => {
    const [linear, github] = maskMcpServers(stored);
    if (linear?.type !== "http" || github?.type !== "stdio") throw new Error("fixture");
    const merged = mergeMcpServers(
      [
        { ...linear, headers: { authorization: "Bearer new" } },
        { ...github, env: { TOKEN: MASKED, EXTRA: MASKED } },
      ],
      stored,
    );
    expect(merged[0]).toMatchObject({ headers: { authorization: "Bearer new" } });
    expect(merged[1]).toMatchObject({ env: { TOKEN: "ghp_real" } });
  });

  it("doesn't carry secrets across a server that changed type", () => {
    const merged = mergeMcpServers(
      [{ name: "linear", type: "stdio", command: "x", args: [], env: { authorization: MASKED } }],
      stored,
    );
    expect(merged[0]).toMatchObject({ env: {} });
  });
});
