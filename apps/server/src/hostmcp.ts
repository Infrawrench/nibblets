import {
  HostTools,
  JsonValue,
  mcpTarget,
  needsApproval,
  RpcError,
  TailscaleStatus,
  type HostTool,
  type McpServerDef,
} from "@nibblet/protocol";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { z } from "zod";
import { declinedText } from "./approvals.ts";
import type { Conductor } from "./conductor.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

/** Whether a nibblet may reach a host MCP server: only ones ticked for it. */
export function hostToolAllowed(hostTools: readonly string[], name: string): boolean {
  return hostTools.includes(name);
}

const PASS_REQUEST = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const PASS_RESPONSE = ["content-type", "mcp-session-id", "cache-control"];

/** The `tools/call` in a JSON-RPC request body, if that's what it is. */
export function toolCallIn(body: string): { id: JsonValue; tool: string; input: JsonValue } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const msg = ToolCallMessage.safeParse(parsed);
  if (!msg.success) return null;
  return { id: msg.data.id, tool: msg.data.params.name, input: msg.data.params.arguments ?? {} };
}

const ToolCallMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
  params: z.object({ name: z.string(), arguments: JsonValue.optional() }),
});

/** A JSON-RPC reply standing in for a declined call: an error result the agent reads. */
export function declinedReply(id: JsonValue, text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  });
}

/**
 * `ALL /hostmcp/:name`: a nibblet's harness talking to one of the host's
 * MCP servers. Authenticated by the nibblet's own token, limited to the
 * servers ticked for it, and forwarded to the host bridge with the bridge's
 * token. Bodies stream both ways, so SSE responses arrive as they're sent.
 */
export function hostMcpHandler(deps: { store: Store; config: Config; conductor: Conductor }) {
  return async (c: Context) => {
    const { config, store, conductor } = deps;
    if (!config.HOST_MCP_URL) return c.json({ error: "No host bridge is configured" }, 503);
    const auth = c.req.header("authorization") ?? "";
    const row = auth.startsWith("Bearer ") ? await store.nibbletByToken(auth.slice(7)) : null;
    if (!row) return c.json({ error: "unauthorized" }, 401);
    const name = c.req.param("name") ?? "";
    if (!hostToolAllowed(row.hostTools, name)) {
      return c.json({ error: `${name} isn't turned on for this nibblet` }, 403);
    }

    const headers = new Headers({ authorization: `Bearer ${config.HOST_MCP_TOKEN}` });
    for (const h of PASS_REQUEST) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    // Requests are small JSON-RPC messages, so read them whole: a gated
    // `tools/call` waits here for the user before it reaches the host.
    let body: string | undefined;
    if (method === "POST") {
      body = await c.req.text();
      const call = toolCallIn(body);
      const server = `host_${name}`;
      if (call && needsApproval(row.toolApprovals, server, call.tool)) {
        const decision = await conductor.approvals.request(row.id, conductor.activeTurnId(row.id), {
          server,
          tool: call.tool,
          input: call.input,
        });
        if (!decision.approved) {
          return new Response(declinedReply(call.id, declinedText(decision)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
    }

    const res = await fetch(`${config.HOST_MCP_URL}/mcp/${encodeURIComponent(name)}`, {
      method,
      headers,
      body: body ?? (hasBody ? c.req.raw.body : undefined),
      // Node's fetch needs this to stream a request body.
      ...(hasBody && body === undefined ? { duplex: "half" } : {}),
      signal: c.req.raw.signal,
    }).catch(() => null);
    if (!res) return c.json({ error: "Host bridge unreachable" }, 502);

    const out = new Headers();
    for (const h of PASS_RESPONSE) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
}

/** The host bridge's servers, or why there aren't any. */
export async function hostTools(config: Config): Promise<HostTools> {
  if (!config.HOST_MCP_URL) {
    return { connected: false, detail: "No host bridge is configured", servers: [] };
  }
  try {
    const res = await fetch(`${config.HOST_MCP_URL}/servers`, {
      headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = HostTools.shape.servers.parse(await res.json());
    return { connected: true, detail: null, servers };
  } catch (err) {
    const detail = `Host bridge unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return { connected: false, detail, servers: [] };
  }
}

/**
 * A nibblet's own MCP servers minus any that duplicate a host tool it has
 * ticked: the same name, URL or command line. The host's copy wins, so the
 * nibblet never sees one server's tools twice.
 */
export function dropOverlaps(
  own: McpServerDef[],
  enabledHostTools: readonly string[],
  host: readonly HostTool[],
): McpServerDef[] {
  const enabled = host.filter((h) => enabledHostTools.includes(h.name));
  const names = new Set(enabled.map((h) => h.name.toLowerCase()));
  const prints = new Set(enabled.map((h) => h.fingerprint));
  return own.filter(
    (s) => !names.has(s.name.toLowerCase()) && !prints.has(fingerprint(mcpTarget(s))),
  );
}

function fingerprint(target: string): string {
  return createHash("sha256").update(target).digest("hex");
}

const noTailscale = (detail: string): TailscaleStatus => ({
  installed: false,
  running: false,
  serving: false,
  url: null,
  detail,
  action: null,
});

/** Tailscale on the host, through the bridge, which is what can run `tailscale serve`. */
export async function tailscaleStatus(config: Config): Promise<TailscaleStatus> {
  if (!config.HOST_MCP_URL) return noTailscale("Needs the host bridge (the desktop app runs it)");
  try {
    const res = await fetch(`${config.HOST_MCP_URL}/tailscale`, {
      headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return TailscaleStatus.parse(await res.json());
  } catch (err) {
    return noTailscale(
      `Host bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function setTailscale(config: Config, serving: boolean): Promise<TailscaleStatus> {
  if (!config.HOST_MCP_URL) return noTailscale("Needs the host bridge (the desktop app runs it)");
  const res = await fetch(`${config.HOST_MCP_URL}/tailscale`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.HOST_MCP_TOKEN}`,
    },
    body: JSON.stringify({ serving }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new RpcError("unavailable", `The host bridge refused (${res.status})`);
  return TailscaleStatus.parse(await res.json());
}

/** Starts signing the host in to Tailscale; the answer carries the link that finishes it. */
export async function tailscaleLogin(config: Config): Promise<TailscaleStatus> {
  if (!config.HOST_MCP_URL) return noTailscale("Needs the host bridge (the desktop app runs it)");
  const res = await fetch(`${config.HOST_MCP_URL}/tailscale/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new RpcError("unavailable", `The host bridge refused (${res.status})`);
  return TailscaleStatus.parse(await res.json());
}
