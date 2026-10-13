import {
  TurnWriter,
  type HarnessContext,
  type HarnessPlugin,
  type HarnessSession,
  type McpServerSpec,
} from "@nibblet/harness";
import type { HarnessId, RunnerConfig, RunnerToServer, ServerToRunner } from "@nibblet/protocol";
import { CliLogins } from "./cli.ts";

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
        void this.drain();
        return;
      case "turn":
        this.queue.push(msg);
        void this.drain();
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
      config.mcpServers,
      // Changed logins need a fresh harness so its agents see the new env.
      config.cli,
      config.opencodeLogin,
    ]);
    if (this.session?.key === key) return this.session.session;
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

  private async runTurn(turn: TurnMessage): Promise<void> {
    const config = this.config;
    if (!config) return;
    const abort = new AbortController();
    this.current = { turnId: turn.turnId, abort };
    const out = new TurnWriter(turn.turnId, (item) => this.deps.send({ type: "item", item }));
    try {
      const session = await this.ensureSession(config);
      const result = await session.run(
        {
          turnId: turn.turnId,
          source: turn.source,
          input: turn.input,
          system: turn.system,
          signal: abort.signal,
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

/** The built-in servers, plus the host servers ticked for it, plus its own. */
export function mcpServersFor(
  config: RunnerConfig,
  deps: Pick<RunnerDeps, "mcpServers" | "hostMcp">,
): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = { ...deps.mcpServers };
  for (const name of config.hostMcp) out[`host_${name}`] = deps.hostMcp(name);
  for (const server of config.mcpServers) {
    out[server.name] =
      server.type === "http"
        ? { type: "http", url: server.url, headers: server.headers }
        : { type: "stdio", command: server.command, args: server.args, env: server.env };
  }
  return out;
}
