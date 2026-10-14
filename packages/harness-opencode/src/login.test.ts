import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { containerConfig, installLogin, parseModelsVerbose, stripJsonc } from "./login.ts";

const hostConfig = `{
  // The user's own config, comments and all.
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-friends-apartment": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:11434/v1" }, /* local Ollama */
    },
    "lan": { "options": { "baseURL": "http://192.168.1.5:11434/v1" } },
  },
  "mcp": { "opencomputeruse": { "type": "local", "command": ["opencomputeruse", "mcp"] } },
}`;

describe("containerConfig", () => {
  it("strips comments and trailing commas but not // inside strings", () => {
    expect(JSON.parse(stripJsonc('{ "u": "https://x.dev/a//b", // c\n "n": 1, }'))).toEqual({
      u: "https://x.dev/a//b",
      n: 1,
    });
  });

  it("drops the host's MCP servers and points localhost at the host", () => {
    const config = containerConfig(hostConfig);
    expect(config.mcp).toBeUndefined();
    expect(JSON.stringify(config)).toContain("http://host.docker.internal:11434/v1");
    expect(JSON.stringify(config)).toContain("http://192.168.1.5:11434/v1");
  });

  it("copes with no config or a broken one", () => {
    expect(containerConfig(null)).toEqual({});
    expect(containerConfig("{ nope")).toEqual({});
  });

  it("writes the login where OpenCode looks, with the token kept off the home volume", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-login-"));
    try {
      const dirs = { config: path.join(dir, "config"), data: path.join(dir, "data") };
      const secrets = path.join(dir, "secrets");
      // An auth.json an earlier version wrote into the home volume goes.
      await mkdir(path.join(dirs.data, "opencode"), { recursive: true });
      await writeFile(path.join(dirs.data, "opencode", "auth.json"), '{"old":"token"}');
      await installLogin(
        dirs,
        { config: hostConfig, auth: '{"neon":{"type":"api","key":"k"}}' },
        secrets,
      );
      const written = JSON.parse(
        await readFile(path.join(dirs.config, "opencode", "opencode.json"), "utf8"),
      );
      expect(written.provider["my-friends-apartment"].options.baseURL).toBe(
        "http://host.docker.internal:11434/v1",
      );
      const auth = path.join(dirs.data, "opencode", "auth.json");
      expect((await lstat(auth)).isSymbolicLink()).toBe(true);
      expect(await readlink(auth)).toBe(path.join(secrets, "opencode-auth.json"));
      expect(await readFile(auth, "utf8")).toBe('{"neon":{"type":"api","key":"k"}}');
      expect((await stat(auth)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseModelsVerbose", () => {
  it("reads ids and names from the verbose listing", () => {
    const text = [
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "name": "Big Pickle",',
      '  "limit": {',
      '    "context": 200000',
      "  }",
      "}",
      "my-friends-apartment/qwen3.6:27b",
      "{",
      '  "id": "qwen3.6:27b"',
      "}",
    ].join("\n");
    expect(parseModelsVerbose(text)).toEqual([
      { id: "opencode/big-pickle", provider: "opencode", name: "Big Pickle" },
      {
        id: "my-friends-apartment/qwen3.6:27b",
        provider: "my-friends-apartment",
        name: "qwen3.6:27b",
      },
    ]);
  });
});
