import {
  RpcError,
  type FileRef,
  type Nibblet,
  type RunnerToServer,
  type SharedVault,
  type ServerToRunner,
  type ThreadItem,
  type TurnSource,
  type Resources,
  type GuardConfig,
  type McpServerDef,
} from "@nibblet/protocol";
import { z } from "zod";
import { cliLogins } from "./clilogins.ts";
import type { Config } from "./config.ts";
import { Approvals } from "./approvals.ts";
import { heartbeatInput, isQuiet, systemPrompt } from "./context.ts";
import {
  LimitWaits,
  looksLikeUsageLimit,
  ProviderLimits,
  providerFor,
  resumeAt,
  WaitingTurn,
} from "./limits.ts";
import { dropOverlaps, hostTools } from "./hostmcp.ts";
import { onePasswordLogin } from "./onepassword.ts";
import { opencodeLogin } from "./opencode.ts";
import { runnerName, type Orchestrator } from "./docker.ts";
import { guardToken, hashToken, newId, viewToken, type Store } from "./store.ts";

export interface RunnerLink {
  send(message: ServerToRunner): void;
  close(): void;
}

interface QueuedTurn {
  turnId: string;
  source: TurnSource;
  input: string;
  /** Files the user attached to the message that started it. */
  attachments?: FileRef[];
}

interface ActiveTurn extends QueuedTurn {
  startedAt: string;
  lastReply: string;
}

const now = () => new Date().toISOString();

/** Who to pick up again once the server is back from an update or a restart. */
const RESUME_SETTING = "resumeAfterRestart";
const Resume = z.record(
  z.string(),
  z.object({ wasWorking: z.boolean(), turns: z.array(WaitingTurn) }),
);
type Resume = z.infer<typeof Resume>;
const RESUME_INPUT =
  "Nibblets restarted (to update) while you were working, so your last turn was cut short. Carry on where you left off.";

/**
 * Runs nibblets: starts and stops their containers, queues turns from every
 * source (the user, heartbeats, schedules, sub-agents), hands them to the
 * runner one at a time, and stores what comes back.
 */
export class Conductor {
  private readonly links = new Map<string, RunnerLink>();
  private readonly queues = new Map<string, QueuedTurn[]>();
  private readonly active = new Map<string, ActiveTurn>();
  /** Set while an update is on its way: nothing new starts until the server restarts. */
  private paused = false;
  private readonly store: Store;
  private readonly docker: Orchestrator;
  private readonly config: Config;
  /** Gated tool calls waiting for the user. */
  readonly approvals: Approvals;
  /** Nibblets waiting out a subscription usage limit. */
  readonly limits: LimitWaits;
  private readonly providerLimits: ProviderLimits;
  /** Vault names last shared with each runner, for its system prompt. */
  private readonly onePasswordVaults = new Map<string, SharedVault[]>();
  serverName = "nibblet";

  constructor(store: Store, docker: Orchestrator, config: Config) {
    this.store = store;
    this.docker = docker;
    this.config = config;
    this.approvals = new Approvals(store, config.NIBBLET_APPROVAL_TIMEOUT_MINUTES * 60_000);
    this.providerLimits = new ProviderLimits(config);
    this.limits = new LimitWaits(store, {
      restoreQueue: (nibbletId, turns) => this.queues.set(nibbletId, [...turns]),
      resume: (nibbletId) => void this.dispatch(nibbletId),
    });
  }

  /** The turn a nibblet is running now, for tagging what it produces. */
  activeTurnId(nibbletId: string): string | null {
    return this.active.get(nibbletId)?.turnId ?? null;
  }

  /** Brings the database in line with Docker after a server restart. */
  async reconcile(): Promise<void> {
    await this.approvals.resetStale();
    // Running turns live in memory, so any the last server left running ended
    // with it. They're picked up again below, with what an update held back.
    const resume = await this.store.getSetting(RESUME_SETTING, (v) => Resume.parse(v), {});
    await this.store.deleteSetting(RESUME_SETTING);
    for (const { nibbletId, item } of await this.store.runningTurnItems()) {
      await this.store.putItem(nibbletId, { ...item, status: "interrupted", endedAt: now() });
      await this.notice(nibbletId, item.turnId, "info", "Paused while Nibblets restarted");
      resume[nibbletId] = { turns: resume[nibbletId]?.turns ?? [], wasWorking: true };
    }
    await this.limits.restore();
    const runners = await this.docker.runners();
    for (const nibblet of await this.store.listNibblets()) {
      const runner = runners.get(nibblet.id);
      if (runner?.running && (await this.docker.runnerOutdated(nibblet.id))) {
        // The runner image was rebuilt: give it a container with the fixes.
        await this.start(nibblet.id).catch(() => undefined);
      } else if (runner?.running) {
        // Its runner keeps its token and reconnects by itself.
        await this.store.setStatus(nibblet.id, "starting", "Reconnecting");
      } else if (nibblet.status !== "stopped" && nibblet.status !== "error") {
        await this.store.setStatus(nibblet.id, "stopped");
      }
    }
    for (const id of runners.keys()) {
      // A container left from a nibblet that's since been deleted: nothing to keep.
      if (!(await this.store.listNibblets()).some((n) => n.id === id)) {
        await this.docker.removeContainer(runnerName(id));
        await this.docker.removeHome(id);
      }
    }
    await this.docker.watchRunnerExits((id, code) => void this.onContainerExit(id, code));
    await this.resume(resume);
  }

  /**
   * Before an update restarts the server: stops each working nibblet's turn
   * (as the stop button does), holds every queue, and saves both, so they
   * carry on once the new version is up.
   */
  async pauseForUpdate(): Promise<void> {
    this.paused = true;
    const saved: Resume = {};
    for (const id of new Set([...this.active.keys(), ...this.queues.keys()])) {
      const wasWorking = this.active.has(id);
      const turns = this.queues.get(id) ?? [];
      if (!wasWorking && turns.length === 0) continue;
      saved[id] = { wasWorking, turns };
      if (wasWorking) {
        this.interrupt(id);
        void this.notice(id, this.activeTurnId(id), "info", "Paused while Nibblets updates");
      }
    }
    await this.store.setSetting(RESUME_SETTING, saved);
  }

  /** The update didn't happen: carry on now rather than after a restart. */
  async unpause(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    const saved = await this.store.getSetting(RESUME_SETTING, (v) => Resume.parse(v), {});
    await this.store.deleteSetting(RESUME_SETTING);
    for (const [id, { wasWorking }] of Object.entries(saved)) {
      if (wasWorking) {
        await this.enqueue(id, "system", RESUME_INPUT, [], { first: true }).catch(() => undefined);
      }
      void this.dispatch(id);
    }
  }

  /** Puts back what was held over a restart: a nudge to carry on first, then the queue. */
  private async resume(saved: Resume): Promise<void> {
    for (const [id, { wasWorking, turns }] of Object.entries(saved)) {
      const nibblet = await this.store.getNibblet(id).catch(() => null);
      if (!nibblet) continue;
      this.queues.set(id, [...turns, ...(this.queues.get(id) ?? [])]);
      if (wasWorking) {
        await this.enqueue(id, "system", RESUME_INPUT, [], { first: true }).catch(() => undefined);
      } else {
        void this.dispatch(id);
      }
    }
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
          // For the guard alone; the container's entry keeps these from the runner.
          NIBBLET_SERVER_URL: this.config.NIBBLET_INTERNAL_URL,
          NIBBLET_VIEW_TOKEN: viewToken(
            this.config.NIBBLET_OWNER_TOKEN,
            nibbletId,
            hashToken(token),
          ),
          NIBBLET_GUARD_TOKEN: guardToken(
            this.config.NIBBLET_OWNER_TOKEN,
            nibbletId,
            hashToken(token),
          ),
        },
        { sshAgent: nibblet.cliCredentials.includes("ssh"), resources: nibblet.resources },
      );
      return await this.store.updateNibblet(nibbletId, { containerId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.setStatus(nibbletId, "error", `Couldn't start its container: ${message}`);
      throw new RpcError("unavailable", message);
    }
  }

  async stop(nibbletId: string): Promise<Nibblet> {
    await this.approvals.cancelAll(nibbletId, "The nibblet was stopped");
    await this.limits.end(nibbletId, "cancelled");
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
    await this.docker
      .removeHome(nibbletId)
      .catch((err: unknown) => console.warn(`couldn't remove ${nibbletId}'s home`, err));
  }

  /**
   * Queues a turn and records the message that started it. A stopped
   * nibblet is started, since a message to it is a request for it to act.
   */
  async enqueue(
    nibbletId: string,
    source: TurnSource,
    input: string,
    attachments: FileRef[] = [],
    opts: { first?: boolean } = {},
  ): Promise<string> {
    // While waiting out a usage limit, heartbeats and schedules don't pile up.
    if (this.limits.waiting(nibbletId) && (source === "heartbeat" || source === "schedule")) {
      const pending = this.queues.get(nibbletId)?.find((t) => t.source === source);
      if (pending) return pending.turnId;
    }
    const nibblet = await this.store.getNibblet(nibbletId);
    const turnId = newId("turn");
    await this.store.putItem(nibbletId, {
      type: "user_message",
      id: newId("msg"),
      turnId,
      createdAt: now(),
      text: input,
      source,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    const queue = this.queues.get(nibbletId) ?? [];
    // `first`: ahead of anything already waiting.
    if (opts.first) queue.unshift({ turnId, source, input, attachments });
    else queue.push({ turnId, source, input, attachments });
    this.queues.set(nibbletId, queue);
    await this.limits.saveTurns(nibbletId, queue);
    await this.store.updateNibblet(nibbletId, { lastActivityAt: new Date() });

    // The caller only needs the message recorded; waking the container and
    // preparing the turn carry on without holding up the reply.
    const wake = (async () => {
      const outdated =
        !this.active.has(nibbletId) &&
        nibblet.status !== "stopped" &&
        (await this.docker.runnerOutdated(nibbletId));
      if (nibblet.status === "stopped" || nibblet.status === "error" || outdated) {
        // A recreated runner picks the queue up once it connects.
        await this.start(nibbletId);
      } else {
        await this.dispatch(nibbletId);
      }
    })();
    void wake.catch((err: unknown) => console.error(`couldn't run ${nibbletId}'s turn`, err));
    return turnId;
  }

  /**
   * Runs one of a nibblet's heartbeats by name, or with no name a general
   * check-in (the "Check in now" button). Skipped while it's busy.
   */
  async heartbeat(nibbletId: string, name: string | null = null): Promise<void> {
    if (this.busy(nibbletId)) return;
    const nibblet = await this.store.getNibblet(nibbletId);
    const beat = name ? (nibblet.heartbeats.find((h) => h.name === name) ?? null) : null;
    if (name && !beat) return;
    if (beat) {
      const ranAt = new Date().toISOString();
      await this.store.setHeartbeats(
        nibbletId,
        nibblet.heartbeats.map((h) => (h.name === beat.name ? { ...h, lastRunAt: ranAt } : h)),
      );
    }
    await this.enqueue(nibbletId, "heartbeat", heartbeatInput(beat));
  }

  /** New CPU and memory limits, applied to a running container straight away. */
  applyResources(nibbletId: string, resources: Resources): Promise<void> {
    return this.docker.applyResources(nibbletId, resources);
  }

  hostCapacity(): Promise<{ cpus: number; memoryMb: number } | null> {
    return this.docker.hostCapacity();
  }

  busy(nibbletId: string): boolean {
    return this.active.has(nibbletId) || (this.queues.get(nibbletId)?.length ?? 0) > 0;
  }

  interrupt(nibbletId: string): void {
    void this.approvals.cancelAll(nibbletId, "The turn was stopped");
    void this.limits.end(nibbletId, "cancelled");
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
    const onePassword = await onePasswordLogin(this.config, this.store, nibbletId, (m) =>
      console.warn(`[${nibbletId}] ${m}`),
    );
    if (onePassword) this.onePasswordVaults.set(nibbletId, onePassword.vaults);
    else this.onePasswordVaults.delete(nibbletId);
    const mcpServers = await this.ownMcpServers(row);
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
        // Names only: the guard fetches the settings and secrets behind them itself.
        gated: [
          ...(row.browser ? ["computer"] : []),
          ...(onePassword ? ["onepassword"] : []),
          ...mcpServers.map((server) => server.name),
        ],
        cli: await cliLogins(this.config, row.cliCredentials, (m) =>
          console.warn(`[${nibbletId}] ${m}`),
        ),
        opencodeLogin:
          row.harness === "opencode"
            ? await opencodeLogin(this.config, row.model, (m) =>
                console.warn(`[${nibbletId}] ${m}`),
              )
            : null,
      },
    });
  }

  /** Its own MCP servers, less any the host's tools now cover. */
  private async ownMcpServers(row: { hostTools: string[]; mcpServers: McpServerDef[] }) {
    return row.hostTools.length > 0 && this.config.HOST_MCP_URL
      ? dropOverlaps(row.mcpServers, row.hostTools, (await hostTools(this.config)).servers)
      : row.mcpServers;
  }

  /**
   * What a nibblet's guard runs, with the secrets it needs: fetched by the
   * guard itself, so they never pass through the runner or the agent's user.
   */
  async guardConfig(nibbletId: string): Promise<GuardConfig> {
    const row = await this.store.nibbletRow(nibbletId);
    const onePassword = await onePasswordLogin(this.config, this.store, nibbletId, (m) =>
      console.warn(`[${nibbletId}] ${m}`),
    );
    return {
      browser: row.browser,
      toolApprovals: row.toolApprovals,
      mcpServers: await this.ownMcpServers(row),
      onePassword,
    };
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
      case "approval_request": {
        // Answered whenever the user decides; the runner holds the call until then.
        const { approvalId, server, tool, input } = message;
        void this.approvals
          .request(nibbletId, this.activeTurnId(nibbletId), { server, tool, input })
          .then((d) =>
            this.links.get(nibbletId)?.send({
              type: "approval_decision",
              approvalId,
              approved: d.approved,
              reason: d.reason,
            }),
          )
          .catch((err: unknown) => console.error(`approval for ${nibbletId} failed`, err));
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

  /** "Try now": stop waiting out a usage limit and run what's queued. */
  async resumeNow(nibbletId: string): Promise<void> {
    this.providerLimits.invalidate();
    await this.limits.end(nibbletId, "resumed");
  }

  private async dispatch(nibbletId: string): Promise<void> {
    const link = this.links.get(nibbletId);
    if (this.paused) return;
    if (!link || this.active.has(nibbletId) || this.limits.waiting(nibbletId)) return;
    if (!this.queues.get(nibbletId)?.length) return;
    // Don't send work into a subscription that's known to be out of usage.
    const nibblet = await this.store.getNibblet(nibbletId);
    const provider = providerFor(nibblet);
    const limited = provider ? await this.providerLimits.until(provider) : null;
    if (limited) {
      await this.limits.start(nibbletId, provider, resumeAt(limited, new Date()), [
        ...(this.queues.get(nibbletId) ?? []),
      ]);
      return;
    }
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
        attachments: next.attachments ?? [],
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
      .searchMemories({ nibbletId, query: input.slice(0, 2000), limit: 8, trustedOnly: true })
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
      onePasswordVaults: this.onePasswordVaults.get(nibbletId),
    });
  }

  private async finishTurn(
    nibbletId: string,
    end: Extract<RunnerToServer, { type: "turn_end" }>,
  ): Promise<void> {
    const turn = this.active.get(nibbletId);
    if (!turn || turn.turnId !== end.turnId) return;
    this.active.delete(nibbletId);

    if (end.status === "failed" && (await this.waitOutLimit(nibbletId, turn, end.error))) return;

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

  /**
   * A turn that failed because the subscription is out of usage goes back on
   * the queue, and the nibblet waits for the limit to reset. True if it did.
   */
  private async waitOutLimit(
    nibbletId: string,
    turn: ActiveTurn,
    error: string | null,
  ): Promise<boolean> {
    const nibblet = await this.store.getNibblet(nibbletId);
    const provider = providerFor(nibblet);
    this.providerLimits.invalidate();
    const limited = provider ? await this.providerLimits.until(provider) : null;
    if (!limited && !looksLikeUsageLimit(error)) return false;
    await this.putTurnItem(nibbletId, turn, "interrupted", false, null);
    const queue = this.queues.get(nibbletId) ?? [];
    queue.unshift({ turnId: turn.turnId, source: turn.source, input: turn.input });
    this.queues.set(nibbletId, queue);
    await this.limits.start(nibbletId, provider, resumeAt(limited, new Date()), queue);
    return true;
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
