import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
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
  const k3 = ["low", "high", "max"] as const;
  const read = (
    host: string | null,
    effort: "low" | "medium" | "high" | "max",
    efforts: readonly ("low" | "high" | "max")[] = k3,
  ) => parse(kimiConfig({ config: host, token: null }, effort, efforts)) as Record<string, any>;

  it("keeps the host's providers and models", () => {
    const config = read(hostConfig, "low");
    expect(config.providers["managed:kimi-code"].base_url).toBe("https://api.kimi.com/coding/v1");
    expect(config.models["kimi-code/k3"].model).toBe("k3");
    expect(config.default_model).toBe("kimi-code/k3");
  });

  it("sets the effort on the host's thinking table rather than defining it twice", () => {
    const text = kimiConfig({ config: hostConfig, token: null }, "max", k3);
    expect(text.match(/^\[thinking\]/gm)).toHaveLength(1);
    expect(parse(text).thinking).toEqual({ enabled: true, effort: "max", keep: "all" });
  });

  it("turns telemetry off, and leaves telemetry keys in other tables alone", () => {
    const config = read(`${hostConfig}\n[plugins.x]\ntelemetry = true\n`, "high");
    expect(config.telemetry).toBe(false);
    expect(config.plugins.x.telemetry).toBe(true);
  });

  it.each([
    ["an indented table", "  [thinking]\n  enabled = false\n"],
    ["a quoted table", '["thinking"]\nenabled = false\n'],
    ["a dotted key", "thinking.enabled = false\n"],
    ["an inline table", "thinking = { enabled = false }\n"],
  ])("replaces thinking written as %s", (_, host) => {
    expect(read(host, "low").thinking).toEqual({ enabled: true, effort: "low" });
  });

  it("isn't thrown by a multi-line array whose lines start with a bracket", () => {
    const host = 'paths = [\n  [ "a" ],\n]\n[thinking]\nenabled = false\n';
    const config = read(host, "high");
    expect(config.paths).toEqual([["a"]]);
    expect(config.thinking).toEqual({ enabled: true, effort: "high" });
  });

  it("leaves the host's thinking alone for a model without effort levels", () => {
    const config = read(`${hostConfig}`.replace("enabled = true", "enabled = false"), "medium", []);
    expect(config.thinking).toEqual({ enabled: false, effort: "high", keep: "all" });
  });

  it("produces a valid config when the host has none", () => {
    expect(read(null, "high")).toEqual({
      telemetry: false,
      thinking: { enabled: true, effort: "high" },
    });
  });

  it("says so when the host's config isn't valid TOML", () => {
    expect(() => kimiConfig({ config: "[thinking", token: null }, "high", k3)).toThrow(
      /isn't valid TOML/,
    );
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
  it("links the token and config in from outside the home, so neither is kept there", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kimi-login-"));
    try {
      const home = path.join(root, "home");
      const secrets = path.join(root, "secrets");
      await installLogin(home, '{"access_token":"t"}', hostConfig, secrets);
      const token = path.join(home, "credentials", "kimi-code.json");
      expect((await lstat(token)).isSymbolicLink()).toBe(true);
      expect(await readlink(token)).toBe(path.join(secrets, "kimi-code.json"));
      expect(await readFile(token, "utf8")).toBe('{"access_token":"t"}');
      const config = path.join(home, "config.toml");
      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      expect(path.dirname(await readlink(config))).toBe(secrets);
      expect(await readFile(config, "utf8")).toBe(hostConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a real config an earlier version left in the home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kimi-login-"));
    try {
      const home = path.join(root, "home");
      const secrets = path.join(root, "secrets");
      await installLogin(home, "t", 'api_key = "old"\n', secrets);
      await rm(path.join(home, "config.toml"));
      await writeFile(path.join(home, "config.toml"), 'api_key = "old"\n');
      await installLogin(home, "t", hostConfig, secrets);
      expect((await lstat(path.join(home, "config.toml"))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
