import { z } from "zod";
import { Effort, HarnessId } from "./models.ts";
import { CliLogin, McpServerDef, ToolRule } from "./mcp.ts";
import { SharedVault } from "./onepassword.ts";
import {
  BackgroundTask,
  DesktopApp,
  FileRef,
  JsonValue,
  ThreadItem,
  TurnSource,
  Usage,
} from "./schema.ts";

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

/**
 * The host's Kimi Code CLI `config.toml` and OAuth token, as text, for Kimi
 * nibblets to run on the user's own Kimi subscription. Sent only over the
 * runner socket; never stored.
 */
export const KimiLogin = z.object({
  config: z.string().nullable(),
  token: z.string().nullable(),
});
export type KimiLogin = z.infer<typeof KimiLogin>;

/**
 * A harness's borrowed host login, whichever harness it is: the host's config
 * as text and its one secret (OpenCode's `auth.json`, Kimi's OAuth token).
 * Sent only over the runner socket; never stored.
 */
export const HostLogin = z.object({
  config: z.string().nullable(),
  secret: z.string().nullable(),
});
export type HostLogin = z.infer<typeof HostLogin>;

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
  /**
   * The servers behind the guard's gate: its own MCP servers, the browser
   * and 1Password, by name only. Their settings and secrets go to the guard
   * (see GuardConfig), never to the runner, which shares a user with the agent.
   */
  gated: z.array(z.string()).default([]),
  /** Borrowed host CLI logins, fetched fresh on every configure. Never stored. */
  cli: z.array(CliLogin).default([]),
  /** The host login this harness borrows, or null when it has none (OpenCode then uses the credential proxy). */
  hostLogin: HostLogin.nullable().default(null),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

/**
 * What the guard runs: a separate user in the container, which holds the
 * secrets and enforces "ask me first". It fetches this from the server
 * itself, at `/guard/:id/config`, with its own token.
 */
export const GuardConfig = z.object({
  browser: z.boolean(),
  toolApprovals: z.array(ToolRule).default([]),
  /** This nibblet's own MCP servers, secrets included. */
  mcpServers: z.array(McpServerDef).default([]),
  /** Its 1Password service account, when it's been given vaults. */
  onePassword: z
    .object({ token: z.string(), vaults: z.array(SharedVault) })
    .nullable()
    .default(null),
});
export type GuardConfig = z.infer<typeof GuardConfig>;

/** A call the guard's gate is holding for the person to decide, at `/guard/:id/approval`. */
export const GuardApprovalRequest = z.object({
  server: z.string(),
  tool: z.string(),
  input: JsonValue,
});
export const GuardApprovalDecision = z.object({
  approved: z.boolean(),
  reason: z.string().nullable(),
});

export {
  BROWSER_MCP_PORT,
  DESKTOP_MCP_PORT,
  DESKTOP_VIEW_PORT,
  GATE_PORT,
  VIEW_PORT,
} from "./ports.ts";
/** The container's users: the agent (and the runner) as one, the guard as another. */
export const AGENT_UID = 1001;
export const AGENT_GID = 1002;
export const GUARD_UID = 1100;
export const GUARD_GID = 1100;

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
  /**
   * The user's terminal in the container: a login shell as the agent's user,
   * or, given a task, that task's output followed live.
   */
  z.object({
    type: z.literal("terminal_open"),
    terminalId: z.string(),
    cols: z.int().min(1).max(1000),
    rows: z.int().min(1).max(1000),
    taskId: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("terminal_input"), terminalId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("terminal_resize"),
    terminalId: z.string(),
    cols: z.int().min(1).max(1000),
    rows: z.int().min(1).max(1000),
  }),
  z.object({ type: z.literal("terminal_close"), terminalId: z.string() }),
  /**
   * How much of its output (in UTF-16 code units, as sent) the browser has
   * drawn. A terminal stops reading once too much is still on its way.
   */
  z.object({
    type: z.literal("terminal_ack"),
    terminalId: z.string(),
    chars: z.int().min(0),
  }),
  /** The user stopping one of its background tasks. */
  z.object({ type: z.literal("task_stop"), taskId: z.string() }),
  /** Look again for desktop apps, and send them in an `apps`. */
  z.object({ type: z.literal("apps_scan") }),
]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

export const RunnerToServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    harnessVersion: z.string(),
    /** The turn it's still working on, when it reconnects to a server that restarted. */
    activeTurnId: z.string().nullable().default(null),
    /**
     * Where its browser's view listens in the container, when not on the
     * usual 7900: a sub-agent runs in its parent's container, beside it.
     */
    viewPort: z.number().int().nullable().default(null),
  }),
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
  z.object({ type: z.literal("terminal_output"), terminalId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("terminal_exit"),
    terminalId: z.string(),
    code: z.int().nullable(),
  }),
  /** Its background tasks, whenever they change and on every connect. */
  z.object({ type: z.literal("tasks"), tasks: z.array(BackgroundTask) }),
  /** The desktop apps installed in its container, on every connect and whenever they change. */
  z.object({ type: z.literal("apps"), apps: z.array(DesktopApp) }),
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
  /** This nibblet's key for the proxy; see `HarnessContext.credproxyKey`. */
  NIBBLET_CREDPROXY_KEY: z.string(),
  /** Set when the nibblet has a browser: OpenComputerUse is registered as an MCP server. */
  NIBBLET_BROWSER: z.enum(["0", "1"]).default("0"),
  /**
   * Set for a sub-agent, which runs in its parent's container beside it: the
   * ports its own guard listens on, and where its harness keeps its state so
   * it doesn't share the parent's.
   */
  NIBBLET_GATE_PORT: z.coerce.number().int().optional(),
  NIBBLET_VIEW_PORT: z.coerce.number().int().optional(),
  NIBBLET_STATE_DIR: z.string().optional(),
  /** Set for a sub-agent, which uses its host container's desktop rather than starting one. */
  NIBBLET_SUBAGENT: z.enum(["0", "1"]).default("0"),
  /**
   * The token the container's desktop (OpenComputerUse for apps, run as the
   * agent's user on `DESKTOP_MCP_PORT` and `DESKTOP_VIEW_PORT`) takes. The
   * agent may know it: everything on the desktop is the agent's already.
   * Empty for no desktop.
   */
  NIBBLET_DESKTOP_TOKEN: z.string().default(""),
  /**
   * Set when the container joins the user's tailnet, for its entry: it lets
   * the tailnet reach the ports in `NIBBLET_TAILSCALE_PORTS` (comma
   * separated) and nothing else, then starts Tailscale. Sub-agents use their
   * host container's.
   */
  NIBBLET_TAILSCALE: z.enum(["0", "1"]).default("0"),
  NIBBLET_TAILSCALE_PORTS: z.string().default(""),
});
export type RunnerEnv = z.infer<typeof RunnerEnv>;

/** The guard's environment; the container's entry hands these to the guard alone. */
export const GuardEnv = z.object({
  NIBBLET_ID: z.string(),
  /** The nibblet server, e.g. `http://server:8420`. */
  NIBBLET_SERVER_URL: z.string(),
  NIBBLET_GUARD_TOKEN: z.string(),
  NIBBLET_BROWSER: z.enum(["0", "1"]).default("0"),
  /** Bearer token OpenComputerUse's view server (port 7900) accepts; the server proxies to it. */
  NIBBLET_VIEW_TOKEN: z.string().default(""),
  /** A sub-agent's own ports, beside its parent's guard (7810, 7800 and 7900). */
  NIBBLET_GATE_PORT: z.coerce.number().int().optional(),
  NIBBLET_BROWSER_PORT: z.coerce.number().int().optional(),
  NIBBLET_VIEW_PORT: z.coerce.number().int().optional(),
});
export type GuardEnv = z.infer<typeof GuardEnv>;

/** The environment only the guard may see: the container's entry keeps these from the runner. */
export const GUARD_ONLY_ENV: readonly string[] = ["NIBBLET_GUARD_TOKEN", "NIBBLET_VIEW_TOKEN"];

/** Where a nibblet that borrows the host's SSH agent finds its socket. */
export const CONTAINER_SSH_AUTH_SOCK = "/run/nibblet/ssh-agent.sock";
