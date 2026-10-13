import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Server definitions in the `mcpServers` shape Claude Code and Claude
 * Desktop both use, so a host's existing MCP setup works without copying.
 */
export const StdioServer = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const RemoteServer = z.object({
  type: z.enum(["http", "sse"]),
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const ServerDef = z.union([RemoteServer, StdioServer]);
export type ServerDef = z.infer<typeof ServerDef>;

export interface ConfigSource {
  /** Shown in the UI, e.g. "Claude Code". */
  label: string;
  path: string;
}

export interface HostServer {
  name: string;
  source: string;
  def: ServerDef;
}

/** Names that would point a nibblet back at itself. */
const LOOP_NAMES = new Set(["nibblet", "nibblets"]);

/**
 * Computer-use servers are never shared: on the host they'd drive the
 * user's own screen. Each nibblet has its own in its container instead.
 */
const COMPUTER_USE = /opencomputeruse|computer[-_ ]?use/i;

export function isExcluded(name: string, def: ServerDef): boolean {
  if (LOOP_NAMES.has(name.toLowerCase()) || COMPUTER_USE.test(name)) return true;
  const target = "url" in def ? def.url : [def.command, ...def.args].join(" ");
  return COMPUTER_USE.test(target);
}

/** Where server definitions are read from, first match for a name winning. */
export function defaultSources(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  appData = process.env.APPDATA ?? join(home, "AppData", "Roaming"),
): ConfigSource[] {
  const desktop =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : platform === "win32"
        ? join(appData, "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");
  return [
    { label: "Nibblets", path: join(home, ".nibblet", "host-mcp.json") },
    { label: "Claude Code", path: join(home, ".claude.json") },
    { label: "Claude Desktop", path: desktop },
  ];
}

const ConfigFile = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

/** Parses one config file's text into its valid server definitions. */
export function parseConfig(text: string, label: string): HostServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const file = ConfigFile.safeParse(raw);
  if (!file.success || !file.data.mcpServers) return [];
  const out: HostServer[] = [];
  for (const [name, value] of Object.entries(file.data.mcpServers)) {
    const def = ServerDef.safeParse(value);
    if (def.success && !isExcluded(name, def.data))
      out.push({ name, source: label, def: def.data });
  }
  return out;
}

/** Merges sources in order: the first definition of a name wins. */
export function mergeServers(lists: HostServer[][]): Map<string, HostServer> {
  const out = new Map<string, HostServer>();
  for (const list of lists)
    for (const server of list) if (!out.has(server.name)) out.set(server.name, server);
  return out;
}

export async function loadServers(sources: ConfigSource[]): Promise<Map<string, HostServer>> {
  const lists = await Promise.all(
    sources.map(async (s) => {
      const text = await readFile(s.path, "utf8").catch(() => null);
      return text === null ? [] : parseConfig(text, s.label);
    }),
  );
  return mergeServers(lists);
}

/**
 * The environment a stdio server starts with: what its definition sets,
 * plus enough to find executables. Never the host's whole environment,
 * which may hold credentials the server has no business seeing.
 */
export function serverEnv(def: z.infer<typeof StdioServer>, host: NodeJS.ProcessEnv = process.env) {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "LANG"]) {
    const value = host[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...def.env };
}
