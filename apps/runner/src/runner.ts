import {
  TurnWriter,
  type HarnessContext,
  type HarnessPlugin,
  type HarnessSession,
  type McpServerSpec,
} from "@nibblet/harness";
import {
  type HarnessId,
  type RunnerConfig,
  type RunnerToServer,
  type ServerToRunner,
} from "@nibblet/protocol";
import { CliLogins } from "./cli.ts";
import type { RunnerFiles } from "./files.ts";
import type { SecretFiles } from "./secret-files.ts";

type TurnMessage = Extract<ServerToRunner, { type: "turn" }>;

export interface RunnerDeps {
  plugins: Record<HarnessId, HarnessPlugin>;
  send(msg: RunnerToServer): void;
  workdir: string;
  mcpServers: Record<string, McpServerSpec>;
  /** Builds the spec for a host MCP server, reached through the nibblet server. */
  hostMcp(name: string): McpServerSpec;
  credproxyUrl: string;
  credproxyKey: string;
  /** Where borrowed CLI logins are applied; the process environment by default. */
  cliLogins?: CliLogins;
  /** Where the guard's gate serves one of the servers behind it (the browser, 1Password, its own). */
  gateUrl(name: string): string;
  /** Tells the guard the settings changed, so it fetches them again from the server. */
  refreshGuard?(): Promise<void>;
  /** Fetches a turn's attachments into the workdir. */
  files?: Pick<RunnerFiles, "fetch">;
  /** Where secret files the server hands over (cards) are kept. */
  secrets?: Pick<SecretFiles, "put">;
}

/**
 * The runner's brain, separate from the socket so it can be tested: it
 * opens the configured harness, runs turns one at a time in arrival order,
 * and interrupts the running or a queued turn on request.
 */
export class Runner {
  private readonly deps: RunnerDeps;
  private config: RunnerConfig | null = null;
  private session: { key: string; session: HarnessSession } | null = null;
  private readonly queue: TurnMessage[] = [];
  private current: { turnId: string; abort: AbortController } | null = null;
  private draining = false;
  /** The latest harness session id, so a reopened harness resumes it. */
  private lastSessionId: string | null = null;

  private readonly cli: CliLogins;
  /** The guard catching up with the latest configure; a session waits for it. */
  private guardReady: Promise<void> = Promise.resolve();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.cli = deps.cliLogins ?? new CliLogins();
  }

  handle(msg: ServerToRunner): void {
    switch (msg.type) {
      case "configure":
        if (this.config?.harness !== msg.config.harness) this.lastSessionId = null;
        this.config = msg.config;
        if (msg.config.resumeSessionId) this.lastSessionId = msg.config.resumeSessionId;
        this.guardReady = (this.deps.refreshGuard?.() ?? Promise.resolve()).catch(() => undefined);
        void this.drain();
        return;
      case "turn":
        this.queue.push(msg);
        void this.drain();
        return;
      case "secret_file": {
        const { requestId, name, content } = msg;
        const put =
          this.deps.secrets?.put(name, content) ??
          Promise.reject(new Error("No secret files here"));
        void put.then(
          (path) => this.deps.send({ type: "secret_file_done", requestId, path, error: null }),
          (err: unknown) =>
            this.deps.send({
              type: "secret_file_done",
              requestId,
              path: null,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
        return;
      }
      case "approval_decision":
        // The guard asks the server itself now; nothing here waits on these.
        return;
      case "interrupt":
        if (this.current?.turnId === msg.turnId) {
          this.current.abort.abort();
          return;
        }
        {
          const i = this.queue.findIndex((t) => t.turnId === msg.turnId);
          if (i >= 0) {
            this.queue.splice(i, 1);
            this.deps.send({
              type: "turn_end",
              turnId: msg.turnId,
              status: "interrupted",
              error: null,
              usage: null,
              sessionId: this.lastSessionId,
            });
          }
        }
        return;
    }
  }

  async close(): Promise<void> {
    this.current?.abort.abort();
    await this.session?.session.close();
    this.session = null;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.deps.send({ type: "log", level, message });
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.config) return;
    this.draining = true;
    try {
      for (let turn = this.queue.shift(); turn; turn = this.queue.shift()) {
        await this.runTurn(turn);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Opens the harness, reopening it when anything but the session id changed. */
  private async ensureSession(config: RunnerConfig): Promise<HarnessSession> {
    const key = JSON.stringify([
      config.harness,
      config.model,
      config.effort,
      config.name,
      config.hostMcp,
      config.gated,
      // Changed logins need a fresh harness so its agents see the new env.
      config.cli,
      config.opencodeLogin,
    ]);
    if (this.session?.key === key) return this.session.session;
    await this.guardReady;
    await this.session?.session.close();
    this.session = null;
    for (const failure of await this.cli.apply(config.cli)) this.log("warn", failure);
    const ctx: HarnessContext = {
      config: { ...config, resumeSessionId: this.lastSessionId },
      workdir: this.deps.workdir,
      mcpServers: mcpServersFor(config, this.deps),
      credproxyUrl: this.deps.credproxyUrl,
      credproxyKey: this.deps.credproxyKey,
      log: (level, message) => this.log(level, message),
    };
    const session = await this.deps.plugins[config.harness].open(ctx);
    this.session = { key, session };
    return session;
  }

  /** The turn running now, if any. */
  currentTurnId(): string | null {
    return this.current?.turnId ?? null;
  }

  private async runTurn(turn: TurnMessage): Promise<void> {
    const config = this.config;
    if (!config) return;
    const abort = new AbortController();
    this.current = { turnId: turn.turnId, abort };
    const out = new TurnWriter(turn.turnId, (item) => this.deps.send({ type: "item", item }));
    try {
      const session = await this.ensureSession(config);
      const attachments = (await this.deps.files?.fetch(turn.attachments)) ?? [];
      const result = await session.run(
        {
          turnId: turn.turnId,
          source: turn.source,
          input: turn.input,
          system: turn.system,
          signal: abort.signal,
          attachments,
        },
        out,
      );
      if (result.sessionId) this.lastSessionId = result.sessionId;
      this.deps.send({ type: "turn_end", turnId: turn.turnId, ...result });
    } catch (err) {
      out.finish();
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", `turn ${turn.turnId} failed: ${message}`);
      // A harness that threw is in an unknown state; open a fresh one next time.
      await this.session?.session.close().catch(() => {});
      this.session = null;
      this.deps.send({
        type: "turn_end",
        turnId: turn.turnId,
        status: abort.signal.aborted ? "interrupted" : "failed",
        error: abort.signal.aborted ? null : message,
        usage: null,
        sessionId: this.lastSessionId,
      });
    } finally {
      this.current = null;
    }
  }
}

/**
 * The built-in servers, plus the host servers ticked for it, plus its own.
 * Its own servers and the browser go through the gate, if there is one; host
 * servers are gated by the nibblet server, and `nibblet` itself never is.
 */
export function mcpServersFor(
  config: RunnerConfig,
  deps: Pick<RunnerDeps, "mcpServers" | "hostMcp" | "gateUrl">,
): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = { ...deps.mcpServers };
  for (const name of config.hostMcp) out[`host_${name}`] = deps.hostMcp(name);
  // The browser, 1Password and its own servers: through the guard's gate, by name.
  for (const name of config.gated)
    out[name] = { type: "http", url: deps.gateUrl(name), headers: {} };
  return out;
}
