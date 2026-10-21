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
  type NibbletTailscale,
  type TailnetNode,
  type TailscaleLogin,
  isReservedMcpName,
  tailnetHostname,
  DESKTOP_VIEW_PORT,
  VIEW_PORT,
  type McpServerDef,
} from "@nibblet/protocol";
import { nibbletProxyKey } from "@nibblet/protocol/proxy-key";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliLogins } from "./clilogins.ts";
import type { Config } from "./config.ts";
import { Approvals } from "./approvals.ts";
import { Budgets } from "./budget.ts";
import { heartbeatInput, isQuiet, mayBeQuiet, QUIET_REPLY, systemPrompt } from "./context.ts";
import {
  billedProviderFor,
  LimitWaits,
  looksLikeBudget,
  looksLikeUsageLimit,
  ProviderLimits,
  providerFor,
  resumeAt,
  WaitingTurn,
} from "./limits.ts";
import { dropOverlaps, hostTools } from "./hostmcp.ts";
import { onePasswordLogin } from "./onepassword.ts";
import { keyId, mintAuthKey, readTailnetOAuth } from "./tailnet-keys.ts";
import { hostLoginFor } from "./host-login.ts";
import { runnerName, type Orchestrator } from "./docker.ts";
import { TerminalHub } from "./terminals.ts";
import { desktopToken, guardToken, hashToken, newId, viewToken, type Store } from "./store.ts";

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

/**
 * How long a stopped turn has to end before its container is restarted: the
 * runner's own grace for a harness that ignores the stop, and then some.
 */
const STOP_TIMEOUT_MS = 30_000;

/** Who to pick up again once the server is back from an update or a restart. */
const RESUME_SETTING = "resumeAfterRestart";
const Resume = z.record(
  z.string(),
  z.object({ wasWorking: z.boolean(), turns: z.array(WaitingTurn) }),
);
type Resume = z.infer<typeof Resume>;
const RESUME_INPUT =
  "Nibblets restarted (to update) while you were working, so your last turn was cut short. Carry on where you left off.";
/** How long a sub-agent has to reconnect after a server restart; less than an orphaned turn's wait. */
const RECONNECT_WAIT_MS = 60_000;
const SUBAGENT_RESUME_INPUT =
  "The container you share with your parent restarted while you were working, so your last turn was cut short, and background tasks you started have stopped. Carry on where you left off.";

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
  /**
   * Turns the last server left running, while their runner reconnects: it
   * either says it's still on one (and the turn is adopted) or isn't, and the
   * nibblet is asked to carry on.
   */
  private readonly orphans = new Map<string, Extract<ThreadItem, { type: "turn" }>>();
  private readonly store: Store;
  private readonly docker: Orchestrator;
  private readonly config: Config;
  /** Gated tool calls waiting for the user. */
  readonly approvals: Approvals;
  /** Nibblets waiting out a subscription usage limit. */
  readonly limits: LimitWaits;
  /** Each nibblet's monthly budget for API-key usage, and its spending. */
  readonly budgets: Budgets;
  private readonly providerLimits: ProviderLimits;
  /**
   * Each running sub-agent's current run in its host's container, so the end
   * of one this server replaced or stopped isn't taken for a crash.
   */
  private readonly subagentRuns = new Map<string, symbol>();
  /** Where a sub-agent's browser view is (`host:port`), as its runner said once connected. */
  private readonly views = new Map<string, string>();
  /** Nibblets whose machine is being signed out of the tailnet, by a container of its own. */
  private readonly leaving = new Map<string, Promise<void>>();
  /** Host containers being started for sub-agents, so siblings share one start. */
  private readonly hostStarts = new Map<string, Promise<unknown>>();
  /** Vault names last shared with each runner, for its system prompt. */
  private readonly onePasswordVaults = new Map<string, SharedVault[]>();
  /** The user's terminals in the containers, and the background tasks each reports. */
  readonly terminals = new TerminalHub((nibbletId, message) => {
    const link = this.links.get(nibbletId);
    link?.send(message);
    return link !== undefined;
  });
  serverName = "nibblet";

  constructor(store: Store, docker: Orchestrator, config: Config) {
    this.store = store;
    this.docker = docker;
    this.config = config;
    this.approvals = new Approvals(store, config.NIBBLET_APPROVAL_TIMEOUT_MINUTES * 60_000);
    this.providerLimits = new ProviderLimits(config);
    this.budgets = new Budgets(store);
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
    await this.limits.restore();
    const containers = await this.docker.runners();
    const all = await this.store.listNibblets();
    // A sub-agent runs in the container of the nibblet at the top of its tree.
    const hostOf = (id: string): string => {
      for (let n = all.find((x) => x.id === id); n; n = all.find((x) => x.id === n?.parentId)) {
        if (!n.parentId) return n.id;
      }
      return id;
    };
    // A sub-agent that was stopped isn't running just because its host is,
    // and one from before sub-agents shared their parent's container (which
    // has one of its own, removed below) isn't running in its host at all.
    const runners = new Map(
      all.flatMap((n) => {
        const host = containers.get(hostOf(n.id));
        const stopped = n.parentId && (n.status === "stopped" || n.status === "error");
        const legacy = n.parentId && containers.has(n.id);
        return host && !stopped && !legacy ? [[n.id, host] as const] : [];
      }),
    );
    // Asked once, before any host is recreated below (after which its new
    // container would answer for its sub-agents).
    const outdatedHosts = new Set<string>();
    for (const [id, c] of containers) {
      if (c.running && (await this.docker.runnerOutdated(id))) outdatedHosts.add(id);
    }
    const outdated = (id: string) => outdatedHosts.has(hostOf(id));
    // Running turns live in memory, so the last server lost track of any it
    // left running. A runner that's still up may still be on one: wait for it
    // to say. Otherwise the turn is over, and the nibblet carries on below.
    const resume = await this.store.getSetting(RESUME_SETTING, (v) => Resume.parse(v), {});
    await this.store.deleteSetting(RESUME_SETTING);
    const lost: string[] = [];
    for (const { nibbletId, item } of await this.store.runningTurnItems()) {
      const runner = runners.get(nibbletId);
      const waiting = runner?.running && !outdated(nibbletId);
      if (waiting) {
        this.orphans.set(nibbletId, item);
        setTimeout(() => void this.settleOrphan(nibbletId), 2 * 60_000).unref();
      } else {
        await this.closeLostTurn(nibbletId, item);
        lost.push(nibbletId);
      }
      // Either way, that's what happens to it; nothing else asks it to carry on.
      if (resume[nibbletId]) resume[nibbletId].wasWorking = false;
    }
    for (const nibblet of all) {
      const runner = runners.get(nibblet.id);
      if (nibblet.parentId && runner?.running && outdated(nibblet.id)) {
        // Its host is about to be recreated below, and it with it.
        await this.store.setStatus(nibblet.id, "stopped");
      } else if (runner?.running && outdated(nibblet.id)) {
        // The runner image was rebuilt: give it a container with the fixes.
        await this.start(nibblet.id).catch(() => undefined);
      } else if (runner?.running) {
        // Its runner keeps its token and reconnects by itself.
        await this.store.setStatus(nibblet.id, "starting", "Reconnecting");
        // A container's exit is reported, but nothing would say a sub-agent's
        // processes had gone while this server was away.
        if (nibblet.parentId) this.expectReconnect(nibblet.id);
      } else if (nibblet.status !== "stopped" && nibblet.status !== "error") {
        await this.store.setStatus(nibblet.id, "stopped");
      }
    }
    for (const id of containers.keys()) {
      const nibblet = all.find((n) => n.id === id);
      // A container left from a nibblet that's since been deleted: nothing to keep.
      if (!nibblet) {
        await this.docker.removeContainer(runnerName(id));
        await this.docker.removeHome(id);
      } else if (nibblet.parentId) {
        // A sub-agent from before they ran in their parent's container.
        await this.docker.removeContainer(runnerName(id), { graceful: true });
      }
    }
    await this.docker.watchRunnerExits((id, code) => void this.onContainerExit(id, code));
    for (const id of lost) {
      resume[id] = { turns: resume[id]?.turns ?? [], wasWorking: true };
    }
    await this.resume(resume);
  }

  /**
   * A sub-agent that doesn't reconnect after a server restart has stopped:
   * marked so, the next message to it starts it again rather than waiting on it.
   */
  private expectReconnect(nibbletId: string): void {
    setTimeout(() => {
      void (async () => {
        if (this.links.has(nibbletId)) return;
        const nibblet = await this.store.getNibblet(nibbletId).catch(() => null);
        if (nibblet?.status !== "starting") return;
        this.views.delete(nibbletId);
        await this.store.setStatus(nibbletId, "stopped");
      })().catch((err: unknown) => console.warn(`couldn't settle ${nibbletId}`, err));
    }, RECONNECT_WAIT_MS).unref();
  }

  /** Marks a turn the last server lost as paused, saying so. */
  private async closeLostTurn(
    nibbletId: string,
    item: Extract<ThreadItem, { type: "turn" }>,
  ): Promise<void> {
    await this.store.putItem(nibbletId, { ...item, status: "interrupted", endedAt: now() });
    await this.notice(nibbletId, item.turnId, "info", "Paused while Nibblets restarted");
  }

  /** A lost turn its runner isn't on: closed, and the nibblet asked to carry on. */
  private async settleOrphan(nibbletId: string): Promise<void> {
    const item = this.orphans.get(nibbletId);
    if (!item) return;
    this.orphans.delete(nibbletId);
    await this.closeLostTurn(nibbletId, item);
    await this.enqueue(nibbletId, "system", RESUME_INPUT, [], { first: true }).catch(
      () => undefined,
    );
  }

  /** A lost turn its runner is still on (or has just finished): this server takes it over. */
  private adoptOrphan(nibbletId: string, turnId: string): boolean {
    const item = this.orphans.get(nibbletId);
    if (item?.turnId !== turnId) return false;
    this.orphans.delete(nibbletId);
    this.active.set(nibbletId, {
      turnId,
      source: item.source,
      // Its message isn't to hand; if it has to wait out a limit, it carries on instead.
      input: RESUME_INPUT,
      startedAt: item.createdAt,
      lastReply: "",
    });
    return true;
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

  /** The nibblet whose container a nibblet runs in: itself, or for a sub-agent the top of its tree. */
  private async hostOf(nibblet: Nibblet): Promise<string> {
    let n = nibblet;
    while (n.parentId) n = await this.store.getNibblet(n.parentId);
    return n.id;
  }

  /**
   * Where the server reaches a nibblet's browser view: its own container's
   * 7900, or for a sub-agent the port its runner reported in its host's
   * container. Null for a sub-agent that hasn't reported one (it isn't up).
   */
  browserAddress(nibbletId: string, parentId: string | null): string | null {
    if (!parentId) return `${runnerName(nibbletId)}:${VIEW_PORT}`;
    return this.views.get(nibbletId) ?? null;
  }

  /**
   * Where the server reaches the desktop a nibblet's apps are on, and its
   * token: its own container's, or for a sub-agent its host's. Null when
   * there's no desktop, which comes and goes with the host's browser.
   */
  async desktop(nibbletId: string): Promise<{ address: string; token: string } | null> {
    // One lookup for a nibblet with its own container; the proxy asks on every request.
    let row = await this.store.nibbletRow(nibbletId);
    while (row.parentId) row = await this.store.nibbletRow(row.parentId);
    if (!row.browser) return null;
    return {
      address: `${runnerName(row.id)}:${DESKTOP_VIEW_PORT}`,
      token: desktopToken(this.config.NIBBLET_OWNER_TOKEN, row.id, row.tokenHash),
    };
  }

  async start(nibbletId: string): Promise<Nibblet> {
    const nibblet = await this.store.getNibblet(nibbletId);
    if (nibblet.parentId) return this.startSubagent(nibblet);
    // Its container is about to go, and its sub-agents with it; the ones
    // that were working carry on once it's back.
    const working = await this.subagentsGone(nibbletId, "Its parent's container restarted", {
      resume: true,
    });
    const token = await this.store.rotateToken(nibbletId);
    // Signing a machine out uses its Tailscale state too; one at a time.
    await this.leaving.get(nibbletId);
    const { tailscale } = await this.store.nibbletRow(nibbletId);
    await this.store.updateNibblet(nibbletId, {
      status: "starting",
      statusDetail: null,
      harnessSessionId: null,
      tailnetNode: tailscale
        ? { state: "starting", dnsName: null, ips: [], tailnet: null, detail: null }
        : null,
    });
    try {
      const containerId = await this.docker.startRunner(
        nibbletId,
        this.runnerEnv(nibbletId, token, nibblet.browser, {
          billTo: nibbletId,
          tailscale,
          desktop: nibblet.browser
            ? desktopToken(this.config.NIBBLET_OWNER_TOKEN, nibbletId, hashToken(token))
            : "",
        }),
        {
          sshAgent: nibblet.cliCredentials.includes("ssh"),
          resources: nibblet.resources,
          tailscale: tailscale !== null,
        },
      );
      const started = await this.store.updateNibblet(nibbletId, { containerId });
      for (const id of working) {
        await this.enqueue(id, "system", SUBAGENT_RESUME_INPUT, [], { first: true }).catch(
          (err: unknown) => console.error(`couldn't restart ${id}`, err),
        );
      }
      return started;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.updateNibblet(nibbletId, {
        status: "error",
        statusDetail: `Couldn't start its container: ${message}`,
        tailnetNode: null,
      });
      throw new RpcError("unavailable", message);
    }
  }

  /** The environment a runner and its guard start with. */
  private runnerEnv(
    nibbletId: string,
    token: string,
    browser: boolean,
    {
      billTo,
      tailscale = null,
      desktop,
      subagent = false,
    }: {
      /** Whose budget its API-key usage counts against. */
      billTo: string;
      tailscale?: NibbletTailscale | null;
      desktop: string;
      subagent?: boolean;
    },
  ) {
    return {
      NIBBLET_ID: nibbletId,
      NIBBLET_TOKEN: token,
      NIBBLET_SERVER_WS: `${this.config.NIBBLET_INTERNAL_URL.replace(/^http/, "ws")}/runner`,
      NIBBLET_MCP_URL: `${this.config.NIBBLET_INTERNAL_URL}/mcp`,
      NIBBLET_CREDPROXY_URL: this.config.CREDPROXY_URL,
      // Its own, so the proxy can tell whose budget a request spends.
      NIBBLET_CREDPROXY_KEY: nibbletProxyKey(this.config.CREDPROXY_KEY, billTo),
      NIBBLET_BROWSER: browser ? ("1" as const) : ("0" as const),
      // For the entry, which fences off the rest; the auth key is fetched, never put here.
      NIBBLET_TAILSCALE: tailscale ? ("1" as const) : ("0" as const),
      NIBBLET_TAILSCALE_PORTS: tailscale?.ports.join(",") ?? "",
      // Its container's desktop, which the runner starts (or a sub-agent's joins).
      NIBBLET_DESKTOP_TOKEN: desktop,
      NIBBLET_SUBAGENT: subagent ? ("1" as const) : ("0" as const),
      // For the guard alone; the container's entry keeps these from the runner.
      NIBBLET_SERVER_URL: this.config.NIBBLET_INTERNAL_URL,
      NIBBLET_VIEW_TOKEN: viewToken(this.config.NIBBLET_OWNER_TOKEN, nibbletId, hashToken(token)),
      NIBBLET_GUARD_TOKEN: guardToken(this.config.NIBBLET_OWNER_TOKEN, nibbletId, hashToken(token)),
    };
  }

  /**
   * A sub-agent runs in its parent's container (the top of its tree's, for
   * one a sub-agent started), beside it, so it sees the same files, installed
   * tools and running servers. It has its own browser, gate and harness state.
   * The container is started first if it's down.
   */
  private async startSubagent(nibblet: Nibblet): Promise<Nibblet> {
    const nibbletId = nibblet.id;
    const host = await this.hostOf(nibblet);
    try {
      const starting = this.hostStarts.get(host);
      if (starting) await starting;
      else if (!(await this.docker.runnerRunning(host))) await this.startHost(host);
      const token = await this.store.rotateToken(nibbletId);
      await this.store.updateNibblet(nibbletId, {
        status: "starting",
        statusDetail: null,
        harnessSessionId: null,
      });
      const run = Symbol(nibbletId);
      // The run it replaces ends quietly.
      this.subagentRuns.set(nibbletId, run);
      this.views.delete(nibbletId);
      // Its host's desktop, if the host has one.
      const desktop = await this.desktop(nibbletId);
      await this.docker.startSubagent(
        host,
        nibbletId,
        this.runnerEnv(nibbletId, token, nibblet.browser, {
          // Its host's agent could read its key, so it spends its host's budget.
          billTo: host,
          desktop: desktop?.token ?? "",
          subagent: true,
        }),
        (code, tail) => void this.onSubagentExit(nibbletId, run, code, tail),
      );
      return await this.store.getNibblet(nibbletId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.setStatus(nibbletId, "error", `Couldn't start it: ${message}`);
      throw new RpcError("unavailable", message);
    }
  }

  private async recordView(nibbletId: string, port: number | null): Promise<void> {
    const nibblet = await this.store.getNibblet(nibbletId);
    if (!nibblet.parentId || port === null) {
      this.views.delete(nibbletId);
      return;
    }
    this.views.set(nibbletId, `${runnerName(await this.hostOf(nibblet))}:${port}`);
  }

  /** Starts a sub-agent's host container, once however many of its sub-agents ask at the same time. */
  private startHost(hostId: string): Promise<unknown> {
    let starting = this.hostStarts.get(hostId);
    if (!starting) {
      starting = this.start(hostId).finally(() => this.hostStarts.delete(hostId));
      this.hostStarts.set(hostId, starting);
    }
    return starting;
  }

  /** A sub-agent's guard and runner stopped without being asked to. */
  private async onSubagentExit(
    nibbletId: string,
    run: symbol,
    code: number | null,
    tail: string,
  ): Promise<void> {
    if (this.subagentRuns.get(nibbletId) !== run) return;
    this.subagentRuns.delete(nibbletId);
    this.views.delete(nibbletId);
    const nibblet = await this.store.getNibblet(nibbletId).catch(() => null);
    if (!nibblet || nibblet.status === "stopped") return;
    this.links.get(nibbletId)?.close();
    this.links.delete(nibbletId);
    this.terminals.runnerGone(nibbletId);
    const host = await this.hostOf(nibblet).catch(() => null);
    if (host && !(await this.docker.runnerRunning(host).catch(() => false))) {
      // It went down with its parent's container.
      this.failActive(nibbletId, "interrupted", "Its parent's container stopped");
      await this.store.setStatus(nibbletId, "stopped");
      return;
    }
    this.failActive(nibbletId, "failed", "It stopped");
    const last = tail.trim().split("\n").slice(-3).join(" ");
    await this.store.setStatus(
      nibbletId,
      "error",
      `It exited${code === null ? "" : ` with code ${code}`}${last ? `: ${last}` : ""}`,
    );
  }

  /**
   * Marks a nibblet's sub-agents, and theirs, as stopped, since its container
   * is going (or has gone) and takes them with it. Returns the
   * ones that were working. With `resume` they'll be asked to carry on, so
   * their parents still wait for them; otherwise their parents are told
   * they stopped.
   */
  private async subagentsGone(
    parentId: string,
    reason: string,
    opts: { resume?: boolean } = {},
  ): Promise<string[]> {
    const working: string[] = [];
    for (const child of await this.store.children(parentId)) {
      working.push(...(await this.subagentsGone(child.id, reason, opts)));
      const running = child.status !== "stopped" && child.status !== "error";
      if (!running && !this.links.has(child.id)) continue;
      if (this.busy(child.id)) working.push(child.id);
      this.subagentRuns.delete(child.id);
      this.views.delete(child.id);
      void this.approvals.cancelAll(child.id, reason);
      this.failActive(child.id, "interrupted", reason);
      this.links.get(child.id)?.close();
      this.links.delete(child.id);
      this.terminals.runnerGone(child.id);
      await this.store.updateNibblet(child.id, {
        status: "stopped",
        statusDetail: null,
        harnessSessionId: null,
      });
      if (opts.resume) continue;
      this.queues.delete(child.id);
      const pending = await this.store.runningSubagentItem(parentId, child.id);
      if (pending)
        await this.store.putItem(parentId, { ...pending, status: "error", result: reason });
    }
    return working;
  }

  async stop(nibbletId: string): Promise<Nibblet> {
    await this.approvals.cancelAll(nibbletId, "The nibblet was stopped");
    await this.limits.end(nibbletId, "cancelled");
    this.failActive(nibbletId, "interrupted", "Stopped");
    this.links.get(nibbletId)?.close();
    this.links.delete(nibbletId);
    this.terminals.runnerGone(nibbletId);
    // Mark it stopped first, so the container's exit event reads as expected.
    const stopped = await this.store.updateNibblet(nibbletId, {
      status: "stopped",
      statusDetail: null,
      containerId: null,
      harnessSessionId: null,
      tailnetNode: null,
    });
    this.views.delete(nibbletId);
    if (stopped.parentId) {
      this.subagentRuns.delete(nibbletId);
      await this.docker.stopSubagent(await this.hostOf(stopped), nibbletId);
    } else {
      await this.subagentsGone(nibbletId, "Its parent was stopped");
      await this.docker.stopRunner(nibbletId);
    }
    return stopped;
  }

  async delete(nibbletId: string): Promise<void> {
    // At the same time: each waits for its own processes to stop.
    await Promise.all((await this.store.children(nibbletId)).map((child) => this.delete(child.id)));
    await this.stop(nibbletId).catch(() => undefined);
    this.queues.delete(nibbletId);
    const nibblet = await this.store.getNibblet(nibbletId);
    if (nibblet.parentId) {
      // What it kept in its host's home: its harness's sessions and its browser profile.
      await this.docker
        .removeSubagentState(await this.hostOf(nibblet), nibbletId)
        .catch((err: unknown) => console.warn(`couldn't remove ${nibbletId}'s state`, err));
    }
    // Off the tailnet first, so its machine doesn't linger there with its name.
    if (!nibblet.parentId) await this.leaveTailnet(nibbletId);
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
    if (turn) {
      this.links.get(nibbletId)?.send({ type: "interrupt", turnId: turn.turnId });
      setTimeout(() => void this.forceStop(nibbletId, turn.turnId), STOP_TIMEOUT_MS).unref();
    }
    this.queues.set(nibbletId, []);
  }

  /**
   * A turn still running well after it was stopped means its container is
   * wedged, and every message after it would wait behind it: the turn is
   * closed here and the container started afresh, which picks up what's queued.
   */
  private async forceStop(nibbletId: string, turnId: string): Promise<void> {
    if (this.active.get(nibbletId)?.turnId !== turnId) return;
    console.warn(`[${nibbletId}] turn ${turnId} didn't stop; restarting its container`);
    this.failActive(nibbletId, "interrupted", "It didn't stop, so its container was restarted");
    await this.start(nibbletId).catch((err: unknown) =>
      console.error(`couldn't restart ${nibbletId}`, err),
    );
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
        // Its own window, in its own browser, beside its parent's.
        browser: parent.browser,
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
    const previous = this.links.get(nibbletId);
    previous?.close();
    if (previous && previous !== link) this.terminals.runnerGone(nibbletId);
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
        hostLogin: await hostLoginFor(this.config, row.harness, {
          model: row.model,
          warn: (m) => console.warn(`[${nibbletId}] ${m}`),
        }),
      },
    });
  }

  /** Its own MCP servers, less any the host's tools now cover. */
  private async ownMcpServers(row: { hostTools: string[]; mcpServers: McpServerDef[] }) {
    // One saved before its name was taken by a built-in would replace the built-in.
    const own = row.mcpServers.filter((server) => !isReservedMcpName(server.name));
    return row.hostTools.length > 0 && this.config.HOST_MCP_URL
      ? dropOverlaps(own, row.hostTools, (await hostTools(this.config)).servers)
      : own;
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

  /**
   * What its container's Tailscale joins the tailnet with: fetched with the
   * guard's token, by a user in the container that isn't the agent's. Null
   * when it isn't to join.
   */
  async tailscaleLogin(nibbletId: string): Promise<TailscaleLogin | null> {
    const row = await this.store.nibbletRow(nibbletId);
    if (!row.tailscale || row.parentId) return null;
    return {
      hostname: row.tailscale.hostname || tailnetHostname(row.name),
      ports: row.tailscale.ports,
      keyId: keyId(row.tailscale.authKey, await readTailnetOAuth(this.store)),
    };
  }

  /**
   * A key for its container to sign in with, asked for only when it has to:
   * its own, or a fresh one made with the OAuth client, so keys aren't made
   * on every start for a machine that's already in.
   */
  async tailscaleAuthKey(nibbletId: string): Promise<string> {
    const row = await this.store.nibbletRow(nibbletId);
    if (!row.tailscale || row.parentId) throw new RpcError("not_found", "It isn't to join");
    if (row.tailscale.authKey) return row.tailscale.authKey;
    const oauth = await readTailnetOAuth(this.store);
    if (!oauth) {
      throw new RpcError(
        "unavailable",
        "It has no auth key, and there's no OAuth client in Settings to make one",
      );
    }
    return mintAuthKey(oauth, row.name);
  }

  /** What its container's Tailscale says about its machine on the tailnet. */
  async setTailnetNode(nibbletId: string, node: TailnetNode): Promise<void> {
    const row = await this.store.nibbletRow(nibbletId);
    // A report from a container that's gone, or on its way, doesn't bring it back.
    if (!row.tailscale || row.status === "stopped" || row.status === "error") return;
    if (isDeepStrictEqual(row.tailnetNode, node)) return;
    await this.store.updateNibblet(nibbletId, { tailnetNode: node });
  }

  /**
   * Signs out the machine a nibblet that's asleep (or being deleted) left on
   * the tailnet, in a short-lived container of its own. One that's awake
   * does it itself when its container restarts.
   */
  leaveTailnet(nibbletId: string): Promise<void> {
    const running = this.leaving.get(nibbletId);
    if (running) return running;
    const leaving = this.docker
      .leaveTailnet(nibbletId)
      .catch((err: unknown) => console.warn(`[${nibbletId}] couldn't sign out of the tailnet`, err))
      .finally(() => this.leaving.delete(nibbletId));
    this.leaving.set(nibbletId, leaving);
    return leaving;
  }

  async detach(nibbletId: string, link: RunnerLink): Promise<void> {
    if (this.links.get(nibbletId) !== link) return;
    this.links.delete(nibbletId);
    this.views.delete(nibbletId);
    this.terminals.runnerGone(nibbletId);
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
        await this.recordView(nibbletId, message.viewPort);
        if (this.orphans.has(nibbletId)) {
          const adopted =
            message.activeTurnId !== null && this.adoptOrphan(nibbletId, message.activeTurnId);
          if (!adopted) await this.settleOrphan(nibbletId);
        }
        await this.store.setStatus(nibbletId, this.active.has(nibbletId) ? "working" : "idle");
        await this.dispatch(nibbletId);
        return;
      }
      case "item": {
        const turn = this.active.get(nibbletId);
        if (turn && message.item.type === "assistant_message") turn.lastReply = message.item.text;
        // Hide the reply itself when it's a quiet "nothing to report", and
        // while it's streaming in and might yet be one.
        if (
          turn &&
          message.item.type === "assistant_message" &&
          (message.item.streaming
            ? mayBeQuiet(turn.source, message.item.text)
            : isQuiet(turn.source, message.item.text))
        )
          return;
        await this.store.putItem(nibbletId, message.item);
        return;
      }
      case "turn_end": {
        // A lost turn that finished while the server was away ends normally.
        this.adoptOrphan(nibbletId, message.turnId);
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
      case "terminal_output":
      case "terminal_exit":
      case "tasks":
      case "apps":
        this.terminals.fromRunner(nibbletId, message);
        return;
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
    // Nor into an API key it has spent its budget on.
    const spent = await this.budgetSpent(nibblet);
    if (spent) {
      await this.limits.start(
        nibbletId,
        null,
        spent,
        [...(this.queues.get(nibbletId) ?? [])],
        "budget",
      );
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
    // A sub-agent is on the tailnet as its host container's machine.
    const host = nibblet.parentId
      ? await this.store.nibbletRow(await this.hostOf(nibblet)).catch(() => null)
      : row;
    return systemPrompt({
      nibblet,
      serverName: this.serverName,
      memories: memories.filter((m) => (m.score ?? 0) > 0.45),
      history,
      parent,
      now: new Date(),
      onePasswordVaults: this.onePasswordVaults.get(nibbletId),
      // Its container's, which comes with the host's browser.
      desktop: host?.browser ?? false,
      tailnet:
        host?.tailscale && host.tailnetNode?.state === "running"
          ? { node: host.tailnetNode, ports: host.tailscale.ports }
          : null,
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
    const requeue = async () => {
      await this.putTurnItem(nibbletId, turn, "interrupted", false, null);
      const queue = this.queues.get(nibbletId) ?? [];
      queue.unshift({ turnId: turn.turnId, source: turn.source, input: turn.input });
      this.queues.set(nibbletId, queue);
      return queue;
    };
    // The proxy refused it because the nibblet's budget is spent.
    const spent = looksLikeBudget(error) ? await this.budgetSpent(nibblet) : null;
    if (spent) {
      await this.limits.start(nibbletId, null, spent, await requeue(), "budget");
      return true;
    }
    const limited = provider ? await this.providerLimits.until(provider) : null;
    if (!limited && !looksLikeUsageLimit(error)) return false;
    await this.limits.start(nibbletId, provider, resumeAt(limited, new Date()), await requeue());
    return true;
  }

  /**
   * When a nibblet that has spent its monthly budget on an API key can carry
   * on (the start of next month), or null if it hasn't, or isn't on one.
   */
  private async budgetSpent(nibblet: Nibblet): Promise<Date | null> {
    const provider = billedProviderFor(nibblet);
    if (!provider || !(await this.providerLimits.onApiKey(provider))) return null;
    const status = await this.budgets.status(nibblet.id);
    return status.allowed ? null : new Date(status.resetsAt);
  }

  /**
   * A nibblet's budget changed: whatever was waiting on it (it, and its
   * sub-agents, which spend it too) carries on if there's room now.
   */
  async budgetChanged(nibbletId: string): Promise<void> {
    if (!(await this.budgets.status(nibbletId)).allowed) return;
    for (const id of this.limits.waitingFor("budget")) {
      const owner = await this.budgets.owner(id).catch(() => null);
      if (owner?.id === nibbletId) await this.limits.end(id, "resumed");
    }
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
      `Sub-agent "${child.name}" (${childId}) ${ok ? "finished" : "failed"}:\n\n${result}\n\nIf there's nothing worth telling the user yet, reply with exactly ${QUIET_REPLY}.`,
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
    this.terminals.runnerGone(nibbletId);
    this.failActive(nibbletId, "failed", "Its container stopped");
    await this.subagentsGone(nibbletId, "Its parent's container stopped");
    const logs = await this.docker.runnerLogs(nibbletId, 20);
    const tail = logs.trim().split("\n").slice(-3).join(" ");
    await this.store.updateNibblet(nibbletId, {
      status: "error",
      statusDetail: `Its container exited${code === null ? "" : ` with code ${code}`}${tail ? `: ${tail}` : ""}`,
      tailnetNode: null,
    });
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
