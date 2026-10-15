import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLogin, kimiConfig, mcpConfig } from "./login.ts";

/** A `config.toml` as `kimi login` leaves it, from Kimi's own reference. */
const hostConfig = `default_model = "kimi-code/k3"
telemetry = true

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[thinking]
enabled = true
effort = "high"
keep = "all"

[background]
keep_alive_on_exit = false
`;

describe("kimiConfig", () => {
  it("keeps the host's providers and models", () => {
    const config = kimiConfig({ config: hostConfig, token: null }, "low");
    expect(config).toContain('[providers."managed:kimi-code"]');
    expect(config).toContain('[models."kimi-code/k3"]');
    expect(config).toContain('default_model = "kimi-code/k3"');
  });

  it("replaces the host's thinking table instead of defining it twice", () => {
    const config = kimiConfig({ config: hostConfig, token: null }, "max");
    expect(config.match(/^\[thinking\]/gm)).toHaveLength(1);
    expect(config).toContain('effort = "max"');
    expect(config).not.toContain('keep = "all"');
  });

  it("turns telemetry off once, as a top-level key before every table", () => {
    const config = kimiConfig({ config: hostConfig, token: null }, "high");
    expect(config.match(/^telemetry\s*=/gm)).toHaveLength(1);
    expect(config.startsWith("telemetry = false")).toBe(true);
  });

  it("leaves a table that merely starts with the same letters alone", () => {
    const withOther = `${hostConfig}\n[thinking_rules]\nkeep = "all"\n`;
    const config = kimiConfig({ config: withOther, token: null }, "high");
    expect(config).toContain("[thinking_rules]");
    expect(config).toContain('keep = "all"');
  });

  it("produces a valid config when the host has none", () => {
    const config = kimiConfig({ config: null, token: "t" }, "medium");
    expect(config).toContain('effort = "medium"');
  });
});

describe("mcpConfig", () => {
  it("writes stdio and http servers the way Kimi's mcp.json reads them", () => {
    const json = JSON.parse(
      mcpConfig({
        nibblet: { type: "http", url: "http://nibblet/mcp", headers: { authorization: "x" } },
        host_gh: {
          type: "stdio",
          command: "gh",
          args: ["mcp", "serve"],
          env: { GH_TOKEN: "y" },
        },
      }),
    );
    expect(json.mcpServers.nibblet).toEqual({
      transport: "http",
      url: "http://nibblet/mcp",
      headers: { authorization: "x" },
    });
    expect(json.mcpServers.host_gh).toEqual({
      transport: "stdio",
      command: "gh",
      args: ["mcp", "serve"],
      env: { GH_TOKEN: "y" },
    });
  });
});

describe("installLogin", () => {
  it("links the token in from outside the home, so it is never kept there", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kimi-login-"));
    try {
      const home = path.join(root, "home");
      const secrets = path.join(root, "secrets");
      await installLogin(home, { config: hostConfig, token: '{"access_token":"t"}' }, secrets);
      const link = path.join(home, "credentials", "kimi-code.json");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(path.join(secrets, "kimi-code.json"));
      expect(await readFile(link, "utf8")).toBe('{"access_token":"t"}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no token behind when there is none to install", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kimi-login-"));
    try {
      const home = path.join(root, "home");
      await installLogin(home, { config: hostConfig, token: null }, path.join(root, "secrets"));
      await expect(
        readFile(path.join(home, "credentials", "kimi-code.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
