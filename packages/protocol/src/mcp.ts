import { z } from "zod";

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
    url: z.url(),
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
