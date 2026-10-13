import {
  RpcError,
  type Nibblet,
  type RunnerToServer,
  type ServerToRunner,
  type ThreadItem,
  type TurnSource,
} from "@nibblet/protocol";
import { cliLogins } from "./clilogins.ts";
import type { Config } from "./config.ts";
import { heartbeatInput, isQuiet, systemPrompt } from "./context.ts";
import { dropOverlaps, hostTools } from "./hostmcp.ts";
import type { Orchestrator } from "./docker.ts";
import { hashToken, newId, viewToken, type Store } from "./store.ts";

export interface RunnerLink {
  send(message: ServerToRunner): void;
  close(): void;
}

interface QueuedTurn {
  turnId: string;
  source: TurnSource;
  input: string;
}

interface ActiveTurn extends QueuedTurn {
  startedAt: string;
  lastReply: string;
}

const now = () => new Date().toISOString();

/**
 * Runs nibblets: starts and stops their containers, queues turns from every
 * source (the user, heartbeats, schedules, sub-agents), hands them to the
 * runner one at a time, and stores what comes back.
 */
export class Conductor {
  private readonly links = new Map<string, RunnerLink>();
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly store: Store;
  private readonly docker: Orchestrator;
  private readonly config: Config;
  serverName = "nibblet";

  constructor(store: Store, docker: Orchestrator, config: Config) {
    this.store = store;
    this.docker = docker;
    this.config = config;
  }

  /** Brings the database in line with Docker after a server restart. */
  async reconcile(): Promise<void> {
    const runners = await this.docker.runners();
    for (const nibblet of await this.store.listNibblets()) {
      const runner = runners.get(nibblet.id);
      if (runner?.running) {
        // Its runner keeps its token and reconnects by itself.
        await this.store.setStatus(nibblet.id, "starting", "Reconnecting");
      } else if (nibblet.status !== "stopped" && nibblet.status !== "error") {
        await this.store.setStatus(nibblet.id, "stopped");
      }
    }
    for (const id of runners.keys()) {
      if (!(await this.store.listNibblets()).some((n) => n.id === id))
        await this.docker.stopRunner(id);
    }
    await this.docker.watchRunnerExits((id, code) => void this.onContainerExit(id, code));
  }

  async start(nibbletId: string): Promise<Nibblet> {
    const nibblet = await this.store.getNibblet(nibbletId);
    const token = await this.store.rotateToken(nibbletId);
    await this.store.updateNibblet(nibbletId, {
      status: "starting",
      statusDetail: null,
      harnessSessionId: null,
    });
    try {
      const containerId = await this.docker.startRunner(
        nibbletId,
        {
          NIBBLET_ID: nibbletId,
          NIBBLET_TOKEN: token,
          NIBBLET_SERVER_WS: `${this.config.NIBBLET_INTERNAL_URL.replace(/^http/, "ws")}/runner`,
          NIBBLET_MCP_URL: `${this.config.NIBBLET_INTERNAL_URL}/mcp`,
          NIBBLET_CREDPROXY_URL: this.config.CREDPROXY_URL,
          NIBBLET_CREDPROXY_KEY: this.config.CREDPROXY_KEY,
          NIBBLET_BROWSER: nibblet.browser ? "1" : "0",
          NIBBLET_VIEW_TOKEN: viewToken(
            this.config.NIBBLET_OWNER_TOKEN,
            nibbletId,
            hashToken(token),
          ),
        },
        { sshAgent: nibblet.cliCredentials.includes("ssh") },
      );
      return await this.store.updateNibblet(nibbletId, { containerId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.setStatus(nibbletId, "error", `Couldn't start its container: ${message}`);
      throw new RpcError("unavailable", message);
    }
  }

  async stop(nibbletId: string): Promise<Nibblet> {
    this.failActive(nibbletId, "interrupted", "Stopped");
    this.links.get(nibbletId)?.close();
    this.links.delete(nibbletId);
    // Mark it stopped first, so the container's exit event reads as expected.
    const stopped = await this.store.updateNibblet(nibbletId, {
      status: "stopped",
      statusDetail: null,
      containerId: null,
      harnessSessionId: null,
    });
    await this.docker.stopRunner(nibbletId);
    return stopped;
  }

  async delete(nibbletId: string): Promise<void> {
    for (const child of await this.store.children(nibbletId)) await this.delete(child.id);
    await this.stop(nibbletId).catch(() => undefined);
    this.queues.delete(nibbletId);
    await this.store.deleteNibblet(nibbletId);
  }

  /**
   * Queues a turn and records the message that started it. A stopped
   * nibblet is started, since a message to it is a request for it to act.
   */
  async enqueue(nibbletId: string, source: TurnSource, input: string): Promise<string> {
    const nibblet = await this.store.getNibblet(nibbletId);
    const turnId = newId("turn");
    await this.store.putItem(nibbletId, {
      type: "user_message",
      id: newId("msg"),
      turnId,
      createdAt: now(),
      text: input,
      source,
    });
    const queue = this.queues.get(nibbletId) ?? [];
    queue.push({ turnId, source, input });
    this.queues.set(nibbletId, queue);
    await this.store.updateNibblet(nibbletId, { lastActivityAt: new Date() });

    // The caller only needs the message recorded; waking the container and
    // preparing the turn carry on without holding up the reply.
    const wake =
      nibblet.status === "stopped" || nibblet.status === "error"
        ? this.start(nibbletId).then(() => undefined)
        : this.dispatch(nibbletId);
    void wake.catch((err: unknown) => console.error(`couldn't run ${nibbletId}'s turn`, err));
    return turnId;
  }

  async heartbeat(nibbletId: string): Promise<void> {
    if (this.busy(nibbletId)) return;
    const nibblet = await this.store.getNibblet(nibbletId);
    await this.store.updateNibblet(nibbletId, { lastHeartbeatAt: new Date() });
    await this.enqueue(nibbletId, "heartbeat", heartbeatInput(nibblet));
  }

  busy(nibbletId: string): boolean {
    return this.active.has(nibbletId) || (this.queues.get(nibbletId)?.length ?? 0) > 0;
  }

  interrupt(nibbletId: string): void {
    const turn = this.active.get(nibbletId);
    if (turn) this.links.get(nibbletId)?.send({ type: "interrupt", turnId: turn.turnId });
    this.queues.set(nibbletId, []);
  }

  async spawnSubagent(
    parent: Nibblet,
    task: { name: string; task: string; model?: string; instructions?: string },
    turnId: string | null,
  ): Promise<Nibblet> {
    const { nibblet: child } = await this.store.createNibblet(
      {
        name: task.name,
        harness: parent.harness,
        model: task.model ?? parent.model,
        effort: parent.effort,
        instructions: task.instructions ?? "",
        browser: false,
      },
      parent.id,
    );
    await this.store.putItem(parent.id, {
      type: "subagent",
      id: newId("sub"),
      turnId,
      createdAt: now(),
      childId: child.id,
      task: task.task,
      status: "running",
      result: null,
    });
    await this.enqueue(child.id, "system", task.task);
    return child;
  }

  // Runner connections

  async attach(nibbletId: string, link: RunnerLink): Promise<void> {
    this.links.get(nibbletId)?.close();
    this.links.set(nibbletId, link);
    const row = await this.store.nibbletRow(nibbletId);
    link.send({
      type: "configure",
      config: {
        nibbletId,
        name: row.name,
        harness: row.harness,
        model: row.model,
        effort: row.effort,
        resumeSessionId: row.harnessSessionId,
        hostMcp: this.config.HOST_MCP_URL ? row.hostTools : [],
        mcpServers:
          row.hostTools.length > 0 && this.config.HOST_MCP_URL
            ? dropOverlaps(row.mcpServers, row.hostTools, (await hostTools(this.config)).servers)
            : row.mcpServers,
        cli: await cliLogins(this.config, row.cliCredentials, (m) =>
          console.warn(`[${nibbletId}] ${m}`),
        ),
      },
    });
  }

  async detach(nibbletId: string, link: RunnerLink): Promise<void> {
    if (this.links.get(nibbletId) !== link) return;
    this.links.delete(nibbletId);
    this.failActive(nibbletId, "failed", "Lost touch with its container");
  }

  /** Pushes new settings to a running nibblet's runner. */
  async reconfigure(nibbletId: string): Promise<void> {
    const link = this.links.get(nibbletId);
    if (link) await this.attach(nibbletId, link);
  }

  async onRunnerMessage(nibbletId: string, message: RunnerToServer): Promise<void> {
    switch (message.type) {
      case "ready": {
        await this.store.setStatus(nibbletId, this.active.has(nibbletId) ? "working" : "idle");
        await this.dispatch(nibbletId);
        return;
      }
      case "item": {
        const turn = this.active.get(nibbletId);
        if (turn && message.item.type === "assistant_message") turn.lastReply = message.item.text;
        // Hide the reply itself when it's a quiet "nothing to report".
        if (
          turn &&
          message.item.type === "assistant_message" &&
          isQuiet(turn.source, message.item.text)
        )
          return;
        await this.store.putItem(nibbletId, message.item);
        return;
      }
      case "turn_end": {
        await this.finishTurn(nibbletId, message);
        return;
      }
      case "log": {
        const line = `[${nibbletId}] ${message.message}`;
        if (message.level === "error") console.error(line);
        else if (message.level === "warn") console.warn(line);
        else if (process.env.NIBBLET_DEBUG) console.log(line);
        return;
      }
    }
  }

  private async dispatch(nibbletId: string): Promise<void> {
    const link = this.links.get(nibbletId);
    if (!link || this.active.has(nibbletId)) return;
    const next = this.queues.get(nibbletId)?.shift();
    if (!next) return;

    const turn: ActiveTurn = { ...next, startedAt: now(), lastReply: "" };
    this.active.set(nibbletId, turn);
    await this.putTurnItem(nibbletId, turn, "running", false, null);
    await this.store.setStatus(nibbletId, "working");

    try {
      const system = await this.buildSystem(nibbletId, next.input);
      link.send({
        type: "turn",
        turnId: next.turnId,
        source: next.source,
        input: next.input,
        system,
      });
    } catch (err) {
      this.active.delete(nibbletId);
      const message = err instanceof Error ? err.message : String(err);
      await this.putTurnItem(nibbletId, turn, "failed", false, null);
      await this.notice(nibbletId, turn.turnId, "error", `Couldn't prepare the turn: ${message}`);
      await this.store.setStatus(nibbletId, "idle");
    }
  }

  private async buildSystem(nibbletId: string, input: string) {
    const row = await this.store.nibbletRow(nibbletId);
    const nibblet = await this.store.getNibblet(nibbletId);
    const memories = await this.store
      .searchMemories({ nibbletId, query: input.slice(0, 2000), limit: 8 })
      .catch((err: unknown) => {
        console.warn("memory search failed", err);
        return [];
      });
    const history = row.harnessSessionId ? null : await this.store.recentItems(nibbletId, 80);
    const parent = nibblet.parentId
      ? await this.store.getNibblet(nibblet.parentId).catch(() => null)
      : null;
    return systemPrompt({
      nibblet,
      serverName: this.serverName,
      memories: memories.filter((m) => (m.score ?? 0) > 0.45),
      history,
      parent,
      now: new Date(),
    });
  }

  private async finishTurn(
    nibbletId: string,
    end: Extract<RunnerToServer, { type: "turn_end" }>,
  ): Promise<void> {
    const turn = this.active.get(nibbletId);
    if (!turn || turn.turnId !== end.turnId) return;
    this.active.delete(nibbletId);

    const quiet = end.status === "completed" && isQuiet(turn.source, turn.lastReply);
    await this.putTurnItem(nibbletId, turn, end.status, quiet, end.usage);
    if (end.error) await this.notice(nibbletId, turn.turnId, "error", end.error);
    await this.store.updateNibblet(nibbletId, {
      status: "idle",
      statusDetail: null,
      lastActivityAt: new Date(),
      ...(end.sessionId ? { harnessSessionId: end.sessionId } : {}),
    });

    if (!quiet && end.status === "completed" && turn.lastReply.trim()) {
      void this.indexTranscript(nibbletId, turn).catch((err: unknown) =>
        console.warn("indexing failed", err),
      );
    }
    await this.reportToParent(nibbletId, turn, end);
    await this.dispatch(nibbletId);
  }

  /** Sends a finished sub-agent's answer back to the nibblet that asked for it. */
  private async reportToParent(
    childId: string,
    turn: ActiveTurn,
    end: Extract<RunnerToServer, { type: "turn_end" }>,
  ): Promise<void> {
    const child = await this.store.getNibblet(childId);
    if (!child.parentId || turn.source !== "system") return;
    // Only the task it was spawned with reports back, once.
    const pending = await this.store.runningSubagentItem(child.parentId, childId);
    if (!pending) return;
    const ok = end.status === "completed";
    const result = ok ? turn.lastReply : (end.error ?? `Ended: ${end.status}`);
    await this.store.putItem(child.parentId, { ...pending, status: ok ? "done" : "error", result });
    await this.enqueue(
      child.parentId,
      "subagent",
      `Sub-agent "${child.name}" (${childId}) ${ok ? "finished" : "failed"}:\n\n${result}`,
    );
    // Its work is done; it can sleep until someone messages it directly.
    await this.stop(childId).catch(() => undefined);
  }

  private async indexTranscript(nibbletId: string, turn: ActiveTurn): Promise<void> {
    const content =
      turn.source === "user"
        ? `User: ${turn.input}\n\nYou replied: ${turn.lastReply}`
        : `(${turn.source}) You noted: ${turn.lastReply}`;
    await this.store.saveMemory({
      nibbletId,
      content: content.slice(0, 4000),
      tags: [turn.source],
      kind: "transcript",
    });
  }

  private async onContainerExit(nibbletId: string, code: number | null): Promise<void> {
    const nibblet = await this.store.getNibblet(nibbletId).catch(() => null);
    if (!nibblet || nibblet.status === "stopped") return;
    this.links.delete(nibbletId);
    this.failActive(nibbletId, "failed", "Its container stopped");
    const logs = await this.docker.runnerLogs(nibbletId, 20);
    const tail = logs.trim().split("\n").slice(-3).join(" ");
    await this.store.setStatus(
      nibbletId,
      "error",
      `Its container exited${code === null ? "" : ` with code ${code}`}${tail ? `: ${tail}` : ""}`,
    );
  }

  private failActive(nibbletId: string, status: "failed" | "interrupted", reason: string): void {
    const turn = this.active.get(nibbletId);
    if (!turn) return;
    this.active.delete(nibbletId);
    void this.putTurnItem(nibbletId, turn, status, false, null);
    void this.notice(nibbletId, turn.turnId, status === "failed" ? "error" : "info", reason);
  }

  private async putTurnItem(
    nibbletId: string,
    turn: ActiveTurn,
    status: Extract<ThreadItem, { type: "turn" }>["status"],
    quiet: boolean,
    usage: Extract<ThreadItem, { type: "turn" }>["usage"],
  ): Promise<void> {
    await this.store.putItem(nibbletId, {
      type: "turn",
      id: turn.turnId,
      turnId: turn.turnId,
      createdAt: turn.startedAt,
      source: turn.source,
      status,
      quiet,
      usage,
      endedAt: status === "running" ? null : now(),
    });
  }

  private async notice(
    nibbletId: string,
    turnId: string | null,
    level: "info" | "warning" | "error",
    text: string,
  ) {
    await this.store.putItem(nibbletId, {
      type: "notice",
      id: newId("note"),
      turnId,
      createdAt: now(),
      level,
      text,
    });
  }
}
