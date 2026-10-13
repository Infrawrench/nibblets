import { McpServerDef, McpServerName } from "@nibblet/protocol";
import { z } from "zod";

const Entry = z.union([
  z.object({
    type: z.enum(["http", "streamable-http"]).optional(),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);

/** Makes a name from someone's config fit nibblet's rules, where it can. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Reads a Claude-style `{"mcpServers": {...}}` snippet (or just the inner
 * map) into server definitions, with a reason for each one it skipped.
 */
export function importMcpJson(text: string): { servers: McpServerDef[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { servers: [], errors: ["That isn't valid JSON"] };
  }
  const outer = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).safeParse(raw);
  const map = outer.success
    ? outer.data.mcpServers
    : z.record(z.string(), z.unknown()).safeParse(raw).data;
  if (!map) return { servers: [], errors: ['Expected {"mcpServers": {...}}'] };

  const servers: McpServerDef[] = [];
  const errors: string[] = [];
  for (const [rawName, value] of Object.entries(map)) {
    const name = slugify(rawName);
    if (!McpServerName.safeParse(name).success) {
      errors.push(`${rawName}: that name can't be used`);
      continue;
    }
    const entry = Entry.safeParse(value);
    if (!entry.success) {
      errors.push(`${rawName}: needs a url, or a command (SSE servers aren't supported)`);
      continue;
    }
    const def =
      "url" in entry.data
        ? { name, type: "http", url: entry.data.url, headers: entry.data.headers ?? {} }
        : {
            name,
            type: "stdio",
            command: entry.data.command,
            args: entry.data.args ?? [],
            env: entry.data.env ?? {},
          };
    servers.push(McpServerDef.parse(def));
  }
  return { servers, errors };
}

/** Adds or replaces servers by name, keeping the original order. */
export function upsertServers(list: McpServerDef[], incoming: McpServerDef[]): McpServerDef[] {
  const out = [...list];
  for (const s of incoming) {
    const i = out.findIndex((x) => x.name === s.name);
    if (i >= 0) out[i] = s;
    else out.push(s);
  }
  return out;
}
