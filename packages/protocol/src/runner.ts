import { z } from "zod";
import { Effort, HarnessId } from "./models.ts";
import { CliLogin, McpServerDef, ToolRule } from "./mcp.ts";
import { FileRef, JsonValue, ThreadItem, TurnSource, Usage } from "./schema.ts";

/**
 * The WebSocket between the server and the runner inside each nibblet's
 * container, at `/runner`. The runner holds no state worth keeping: the
 * server sends everything a turn needs and stores everything it produces.
 */

/**
 * The host's OpenCode config and auth.json, as text, for OpenCode nibblets
 * to run on the user's own OpenCode account. Sent only over the runner
 * socket; never stored.
 */
export const OpencodeLogin = z.object({
  config: z.string().nullable(),
  auth: z.string().nullable(),
});
export type OpencodeLogin = z.infer<typeof OpencodeLogin>;

export const RunnerConfig = z.object({
  nibbletId: z.string(),
  name: z.string(),
  harness: HarnessId,
  model: z.string(),
  effort: Effort,
  /** The harness's own session to resume, if this container made one. */
  resumeSessionId: z.string().nullable(),
  /** Host MCP servers to register as `host_<name>`, through the server's `/hostmcp/<name>`. */
  hostMcp: z.array(z.string()).default([]),
  /** This nibblet's own MCP servers, secrets included. */
  mcpServers: z.array(McpServerDef).default([]),
  /** Borrowed host CLI logins, fetched fresh on every configure. Never stored. */
  cli: z.array(CliLogin).default([]),
  /** Tools on its own servers and the browser that wait for the user; host tools are gated by the server. */
  toolApprovals: z.array(ToolRule).default([]),
  /** For OpenCode nibblets: the host's OpenCode login, or null to use the credential proxy. */
  opencodeLogin: OpencodeLogin.nullable().default(null),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

export const ServerToRunner = z.discriminatedUnion("type", [
  z.object({ type: z.literal("configure"), config: RunnerConfig }),
  z.object({
    type: z.literal("turn"),
    turnId: z.string(),
    source: TurnSource,
    input: z.string(),
    /**
     * The system prompt for this turn: instructions, the tools' house rules,
     * memories relevant to the input and, for a fresh session, a recap of the
     * thread so far. Built by the server because the data lives there.
     */
    system: z.string(),
    /** Files the user attached, for the runner to fetch from `/runner/files/:fileId`. */
    attachments: z.array(FileRef).default([]),
  }),
  z.object({ type: z.literal("interrupt"), turnId: z.string() }),
  /** The user's answer to an `approval_request`. */
  z.object({
    type: z.literal("approval_decision"),
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().nullable(),
  }),
]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

export const RunnerToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), harnessVersion: z.string() }),
  z.object({ type: z.literal("item"), item: ThreadItem }),
  z.object({
    type: z.literal("turn_end"),
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "failed"]),
    error: z.string().nullable(),
    usage: Usage.nullable(),
    /** The harness session the next turn can resume. */
    sessionId: z.string().nullable(),
  }),
  /** A gated tool call is waiting; the server asks the user and answers with `approval_decision`. */
  z.object({
    type: z.literal("approval_request"),
    approvalId: z.string(),
    server: z.string(),
    tool: z.string(),
    input: JsonValue,
  }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type RunnerToServer = z.infer<typeof RunnerToServer>;

/** Environment variables the server gives each runner container. */
export const RunnerEnv = z.object({
  NIBBLET_ID: z.string(),
  NIBBLET_TOKEN: z.string(),
  /** e.g. `ws://server:8420/runner` */
  NIBBLET_SERVER_WS: z.string(),
  /** The nibblet tools, as a streamable HTTP MCP server. */
  NIBBLET_MCP_URL: z.string(),
  /** e.g. `http://credproxy:8787`; harnesses get `/anthropic` and `/openai` under it. */
  NIBBLET_CREDPROXY_URL: z.string(),
  /** Shared secret for the proxy; see `HarnessContext.credproxyKey`. */
  NIBBLET_CREDPROXY_KEY: z.string(),
  /** Set when the nibblet has a browser: OpenComputerUse is registered as an MCP server. */
  NIBBLET_BROWSER: z.enum(["0", "1"]).default("0"),
  /** Bearer token OpenComputerUse's view server (port 7900) accepts; the server proxies to it. */
  NIBBLET_VIEW_TOKEN: z.string().default(""),
});
export type RunnerEnv = z.infer<typeof RunnerEnv>;

/** Where a nibblet that borrows the host's SSH agent finds its socket. */
export const CONTAINER_SSH_AUTH_SOCK = "/run/nibblet/ssh-agent.sock";
