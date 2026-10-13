import { describe, expect, it } from "vitest";
import { defaultSources, isExcluded, mergeServers, parseConfig, serverEnv } from "../src/config.ts";

describe("parseConfig", () => {
  it("reads stdio and remote servers and drops invalid ones", () => {
    const servers = parseConfig(
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "files-mcp"] },
          linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { a: "b" } },
          broken: { type: "http" },
        },
      }),
      "Claude Code",
    );
    expect(servers.map((s) => s.name)).toEqual(["files", "linear"]);
    expect(servers[0]?.def).toMatchObject({ command: "npx", args: ["-y", "files-mcp"], env: {} });
    expect(servers.every((s) => s.source === "Claude Code")).toBe(true);
  });

  it("skips nibblet itself so a nibblet can't loop back into its server", () => {
    expect(parseConfig(JSON.stringify({ mcpServers: { Nibblet: { command: "x" } } }), "x")).toEqual(
      [],
    );
  });

  it("tolerates junk files", () => {
    expect(parseConfig("not json", "x")).toEqual([]);
    expect(parseConfig("{}", "x")).toEqual([]);
  });
});

describe("mergeServers", () => {
  it("keeps the first definition of each name", () => {
    const merged = mergeServers([
      parseConfig(JSON.stringify({ mcpServers: { a: { command: "first" } } }), "Nibblets"),
      parseConfig(
        JSON.stringify({ mcpServers: { a: { command: "second" }, b: { command: "b" } } }),
        "Claude Code",
      ),
    ]);
    expect(merged.get("a")?.source).toBe("Nibblets");
    expect(merged.get("b")?.source).toBe("Claude Code");
  });
});

describe("defaultSources", () => {
  it("puts nibblet's own file first and finds Claude Desktop per platform", () => {
    expect(defaultSources("darwin", "/Users/a")[0]?.path).toBe("/Users/a/.nibblet/host-mcp.json");
    expect(defaultSources("darwin", "/Users/a")[2]?.path).toContain(
      "Library/Application Support/Claude",
    );
    expect(defaultSources("linux", "/home/a")[2]?.path).toBe(
      "/home/a/.config/Claude/claude_desktop_config.json",
    );
    expect(defaultSources("win32", "C:/Users/a", "C:/Users/a/AppData/Roaming")[2]?.path).toContain(
      "Roaming",
    );
  });
});

describe("serverEnv", () => {
  it("passes only PATH-like basics plus the definition's own env", () => {
    const env = serverEnv(
      { command: "x", args: [], env: { API_KEY: "k" } },
      { PATH: "/bin", HOME: "/h", AWS_SECRET_ACCESS_KEY: "nope" },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", API_KEY: "k" });
  });
});

describe("isExcluded", () => {
  it("never shares computer-use servers or nibblet itself", () => {
    expect(
      isExcluded("opencomputeruse", { command: "opencomputeruse", args: ["mcp"], env: {} }),
    ).toBe(true);
    expect(
      isExcluded("ocu", { command: "/opt/homebrew/bin/opencomputeruse", args: ["mcp"], env: {} }),
    ).toBe(true);
    expect(
      isExcluded("computer-use", { type: "http", url: "http://localhost:1/mcp", headers: {} }),
    ).toBe(true);
    expect(isExcluded("nibblet", { command: "node", args: [], env: {} })).toBe(true);
    expect(
      isExcluded("neon", { type: "http", url: "https://mcp.neon.tech/mcp", headers: {} }),
    ).toBe(false);
  });
});
