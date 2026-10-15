import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "@nibblet/harness";
import type { Effort, KimiLogin } from "@nibblet/protocol";

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

const TABLE_HEADER = /^\s*\[/;
const THINKING_TABLE = /^\[\[?thinking\s*(\.|\]|\[)/;
const TOP_LEVEL_TELEMETRY = /^\s*telemetry\s*=/;

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
 * The host's `config.toml` with the nibblet's thinking effort applied, and
 * telemetry off. Both are replaced rather than added: TOML can't define the
 * same table or key twice, and a bare key after a table header would belong
 * to that table, so the scalar goes first and the table last.
 */
export function kimiConfig(login: KimiLogin, effort: Effort): string {
  const kept: string[] = [];
  let inThinking = false;
  for (const line of (login.config ?? "").split("\n")) {
    if (TABLE_HEADER.test(line)) inThinking = THINKING_TABLE.test(line);
    if (inThinking || TOP_LEVEL_TELEMETRY.test(line)) continue;
    kept.push(line);
  }
  return [
    "telemetry = false",
    ...kept,
    "",
    "[thinking]",
    "enabled = true",
    `effort = ${JSON.stringify(effort)}`,
    "",
  ].join("\n");
}

/**
 * Writes the login where Kimi Code CLI looks for it under `home`. The token
 * itself goes in `secrets`, outside the home volume (so it's never kept
 * there or copied into a snapshot), and the credentials file is a link to
 * it. Any real credentials file an earlier version left behind is removed.
 */
export async function installLogin(home: string, login: KimiLogin, secrets: string): Promise<void> {
  const dir = path.join(home, KIMI_CREDENTIALS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, KIMI_TOKEN_FILE);
  await rm(target, { force: true, recursive: true });
  if (!login.token) return;
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  const real = path.join(secrets, KIMI_TOKEN_FILE);
  await writeFile(real, login.token, { mode: 0o600 });
  await chmod(real, 0o600);
  await symlink(real, target);
}

/** The MCP servers a nibblet brings, in the file Kimi Code CLI reads. */
export async function writeMcpConfig(
  home: string,
  servers: Record<string, McpServerSpec>,
): Promise<void> {
  await writeFile(path.join(home, "mcp.json"), mcpConfig(servers), { mode: 0o600 });
}
