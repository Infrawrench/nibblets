import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "@nibblet/harness";
import type { Effort, KimiLogin } from "@nibblet/protocol";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";

/**
 * Turning the host's Kimi Code CLI setup into one that works inside a
 * nibblet's container. Kimi keeps its runtime config in `config.toml` and its
 * MCP servers in a separate `mcp.json`, both under `$KIMI_CODE_HOME`, so the
 * container gets the host's config (which names the provider and models the
 * user's own login provisioned) and a file of MCP servers it brings itself.
 */

/** The OAuth token `/login` writes, relative to `$KIMI_CODE_HOME`. */
export const KIMI_CREDENTIALS_DIR = "credentials";
export const KIMI_TOKEN_FILE = "kimi-code.json";
/** The runtime config, relative to `$KIMI_CODE_HOME`. */
export const KIMI_CONFIG_FILE = "config.toml";
/** What the config is kept as in `secrets`, beside the token. */
const KIMI_CONFIG_SECRET = "kimi-config.toml";

/** Kimi's own MCP file format: a `mcpServers` object, stdio or http per entry. */
export function mcpConfig(servers: Record<string, McpServerSpec>): string {
  const entries = Object.entries(servers).map(([name, spec]) => [
    name,
    spec.type === "http"
      ? { transport: "http", url: spec.url, headers: spec.headers }
      : { transport: "stdio", command: spec.command, args: spec.args, env: spec.env },
  ]);
  return JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2);
}

/**
 * The host's `config.toml` with telemetry off and, when the model has effort
 * levels and `effort` is one of them, thinking on at that effort. A model
 * without effort levels keeps whatever thinking setting the host has.
 * Throws when the host's config isn't valid TOML, since Kimi couldn't load
 * it either.
 */
export function kimiConfig(login: KimiLogin, effort: Effort, efforts: readonly Effort[]): string {
  let config: TomlTable;
  try {
    config = parse(login.config ?? "");
  } catch (err) {
    throw new Error(
      `The host's Kimi Code config.toml isn't valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  config.telemetry = false;
  if (efforts.includes(effort)) {
    const host = config.thinking;
    config.thinking = { ...(isTable(host) ? host : {}), enabled: true, effort };
  }
  return `${stringify(config)}\n`;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Writes `content` to `name` in `secrets`, outside the home volume (so it's
 * never kept there or copied into a snapshot), and links `target` to it. Any
 * real file an earlier version left at `target` is removed.
 */
async function linkSecret(
  target: string,
  secrets: string,
  name: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rm(target, { force: true, recursive: true });
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  const real = path.join(secrets, name);
  await writeFile(real, content, { mode: 0o600 });
  await chmod(real, 0o600);
  await symlink(real, target);
}

/**
 * Writes the login where Kimi Code CLI looks for it under `home`: the OAuth
 * token, and the config, which can hold provider API keys of its own. Both
 * live in `secrets` and are linked in.
 */
export async function installLogin(
  home: string,
  token: string,
  config: string,
  secrets: string,
): Promise<void> {
  await linkSecret(
    path.join(home, KIMI_CREDENTIALS_DIR, KIMI_TOKEN_FILE),
    secrets,
    KIMI_TOKEN_FILE,
    token,
  );
  await linkSecret(path.join(home, KIMI_CONFIG_FILE), secrets, KIMI_CONFIG_SECRET, config);
}

/** The MCP servers a nibblet brings, in the file Kimi Code CLI reads. */
export async function writeMcpConfig(
  home: string,
  servers: Record<string, McpServerSpec>,
): Promise<void> {
  await writeFile(path.join(home, "mcp.json"), mcpConfig(servers), { mode: 0o600 });
}
