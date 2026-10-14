import { z } from "zod";
import { WebUrl } from "./urls.ts";

/** Names the runner already uses for its own MCP servers. */
const RESERVED = new Set(["nibblet", "computer"]);

export const McpServerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use lowercase letters, digits, - and _ (up to 40)")
  .refine((n) => !RESERVED.has(n) && !n.startsWith("host_"), "That name is taken by a built-in");

/**
 * An MCP server added to one nibblet. Remote ones are reached from inside
 * its container; stdio ones run inside its container (`npx -y …`).
 * Header and env values are treated as secrets: see `maskMcpServers`.
 */
export const McpServerDef = z.discriminatedUnion("type", [
  z.object({
    name: McpServerName,
    type: z.literal("http"),
    url: WebUrl,
    headers: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    name: McpServerName,
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
]);
export type McpServerDef = z.infer<typeof McpServerDef>;

export const McpServerList = z
  .array(McpServerDef)
  .max(20)
  .refine(
    (list) => new Set(list.map((s) => s.name)).size === list.length,
    "Server names must be unique",
  );

/** Stands in for a stored secret in anything the API returns. */
export const MASKED = "••••";

function maskValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((k) => [k, MASKED]));
}

/** What the API shows: every header and env value replaced by `MASKED`. */
export function maskMcpServers(servers: McpServerDef[]): McpServerDef[] {
  return servers.map((s) =>
    s.type === "http" ? { ...s, headers: maskValues(s.headers) } : { ...s, env: maskValues(s.env) },
  );
}

function unmask(incoming: Record<string, string>, stored: Record<string, string> | undefined) {
  return Object.fromEntries(
    Object.entries(incoming).flatMap(([k, v]): [string, string][] => {
      if (v !== MASKED) return [[k, v]];
      const kept = stored?.[k];
      // A masked value with nothing behind it can't be recovered; drop it.
      return kept === undefined ? [] : [[k, kept]];
    }),
  );
}

/**
 * Applies an update that came from a masked view: a value still equal to
 * `MASKED` keeps the stored secret for that server and key, anything else
 * replaces it, and keys left out are removed.
 */
export function mergeMcpServers(incoming: McpServerDef[], stored: McpServerDef[]): McpServerDef[] {
  const byName = new Map(stored.map((s) => [s.name, s]));
  return incoming.map((s) => {
    const old = byName.get(s.name);
    if (s.type === "http") {
      return { ...s, headers: unmask(s.headers, old?.type === "http" ? old.headers : undefined) };
    }
    return { ...s, env: unmask(s.env, old?.type === "stdio" ? old.env : undefined) };
  });
}

/** One MCP server on the host, as the host bridge reports it. */
/**
 * What an MCP server actually is, for spotting the same server under two
 * names: its URL, or its command line. Hashed before it leaves the host, since
 * arguments can carry secrets.
 */
export function mcpTarget(
  def: { url: string } | { command: string; args?: readonly string[] },
): string {
  if ("url" in def) return def.url.trim().replace(/\/+$/, "").toLowerCase();
  return [def.command, ...(def.args ?? [])].map((p) => p.trim()).join(" ");
}

export const HostTool = z.object({
  name: z.string(),
  source: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** `idle` until a nibblet first uses it: listing never starts a server. */
  status: z.enum(["idle", "ready", "starting", "error"]),
  detail: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
  /** sha256 of `mcpTarget` of its definition. */
  fingerprint: z.string(),
});
export type HostTool = z.infer<typeof HostTool>;

export const HostTools = z.object({
  /** False when no bridge is configured or it can't be reached. */
  connected: z.boolean(),
  detail: z.string().nullable(),
  servers: z.array(HostTool),
});
export type HostTools = z.infer<typeof HostTools>;

/** A host CLI whose login nibblets can borrow, as the host bridge reports it. */
export const CliStatus = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  signedIn: z.boolean(),
  account: z.string().nullable(),
  detail: z.string().nullable(),
});
export type CliStatus = z.infer<typeof CliStatus>;

export const CliStatuses = z.object({
  connected: z.boolean(),
  detail: z.string().nullable(),
  clis: z.array(CliStatus),
});
export type CliStatuses = z.infer<typeof CliStatuses>;

/** A CLI login handed to a runner. Only ever sent over the runner socket. */
export const CliLogin = z.object({
  id: z.string(),
  env: z.record(z.string(), z.string()),
  setup: z.array(z.array(z.string())),
});
export type CliLogin = z.infer<typeof CliLogin>;

/**
 * "Ask me first" for an MCP tool. `server` is the name the harness sees
 * (`host_<name>` for host tools, a nibblet's own server names, `computer` for
 * the browser); `tool` is an exact tool name or a glob where `*` matches
 * anything, so `*` gates a whole server and `send_*` a family of tools.
 */
export const ToolRule = z.object({
  server: z.string().min(1).max(80),
  tool: z.string().min(1).max(120),
});
export type ToolRule = z.infer<typeof ToolRule>;

export const ToolRules = z.array(ToolRule).max(200);

/** Whether `name` matches a pattern where `*` stands for any run of characters. Case-insensitive. */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(name.toLowerCase());
}

/** Whether a call to `tool` on `server` must wait for the user. */
export function needsApproval(rules: readonly ToolRule[], server: string, tool: string): boolean {
  return rules.some((r) => r.server === server && globMatch(r.tool, tool));
}

/**
 * Tool names that look like moving money or destroying things. The UI ticks
 * these for approval when a server is first enabled; the user can untick.
 */
export const RISKY_TOOL_PATTERNS = [
  "*pay*",
  "*transfer*",
  "*send*",
  "*delete*",
  "*purchase*",
] as const;

export function looksRisky(tool: string): boolean {
  return RISKY_TOOL_PATTERNS.some((p) => globMatch(p, tool));
}

/** How long a gated call waits for a decision before it's treated as declined. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000;

/** What a declined or unanswered gated call returns to the agent. */
export function declinedMessage(reason: string | null): string {
  const why = reason ? ` Reason: ${reason}` : "";
  return `The user declined this tool call.${why} Don't retry it unless they ask you to.`;
}
