import {
  CredentialStatus,
  FileRef,
  type BilledProvider,
  TurnSource,
  type HarnessId,
  type ThreadItemOf,
} from "@nibblet/protocol";
import { z } from "zod";
import type { Config } from "./config.ts";
import { newId, type Store } from "./store.ts";

/**
 * Waiting out subscription usage limits, and nibblets' own monthly budgets
 * for API keys. When a turn fails because the nibblet's subscription is out
 * of usage, or its budget is spent, it isn't reported as a failure: the turn
 * goes back on the queue and runs again once the limit resets (or the budget
 * is raised). The wait is kept in settings so a server restart doesn't lose it.
 */

export type LimitProvider = "anthropic" | "openai";

/** Whose subscription a nibblet's turns spend, when the proxy can tell. */
export function providerFor(nibblet: { harness: HarnessId; model: string }): LimitProvider | null {
  if (nibblet.harness === "claude") return "anthropic";
  if (nibblet.harness === "codex") return "openai";
  // OpenCode models are `provider/model`; only these two go through the proxy.
  const prefix = nibblet.model.split("/")[0];
  return prefix === "anthropic" || prefix === "openai" ? prefix : null;
}

/** Which API a nibblet's turns go to through the proxy, whether or not it's billed. */
export function billedProviderFor(nibblet: {
  harness: HarnessId;
  model: string;
}): BilledProvider | null {
  return nibblet.harness === "deepseek" ? "deepseek" : providerFor(nibblet);
}

/** Whether an error is the credential proxy refusing a request over the nibblet's budget. */
export function looksLikeBudget(text: string | null): boolean {
  return text !== null && /monthly budget/i.test(text);
}

/** Whether an error message is a usage limit rather than a real failure. */
export function looksLikeUsageLimit(text: string | null): boolean {
  if (!text) return false;
  return /usage limit|usage_limit|limit reached|rate[ _-]?limit|429|too many requests|quota exceeded|hit your limit/i.test(
    text,
  );
}

/** Resets are a little fuzzy, so resume shortly after; unknown resets get a fixed wait. */
const RESUME_BUFFER_MS = 30_000;
const UNKNOWN_RESET_WAIT_MS = 15 * 60_000;

export function resumeAt(limitedUntil: Date | null, now: Date): Date {
  if (limitedUntil && limitedUntil.getTime() > now.getTime()) {
    return new Date(limitedUntil.getTime() + RESUME_BUFFER_MS);
  }
  return new Date(now.getTime() + UNKNOWN_RESET_WAIT_MS);
}

export const WaitingTurn = z.object({
  turnId: z.string(),
  source: TurnSource,
  input: z.string(),
  // Kept, so a turn that waits out a limit across a restart still has its files.
  attachments: z.array(FileRef).optional(),
});
export type WaitingTurn = z.infer<typeof WaitingTurn>;

export const WaitReason = z.enum(["usage", "budget"]);
export type WaitReason = z.infer<typeof WaitReason>;

const Wait = z.object({
  /** Waits saved before budgets were all for usage limits. */
  reason: WaitReason.default("usage"),
  until: z.iso.datetime(),
  provider: z.enum(["anthropic", "openai"]).nullable(),
  itemId: z.string(),
  turns: z.array(WaitingTurn),
});
type Wait = z.infer<typeof Wait>;

const Waits = z.record(z.string(), Wait);
const SETTING = "limitWaits";
const STATUS_TTL_MS = 15_000;

interface ProxyView {
  /** Whether the proxy answered; nothing below is known if it didn't. */
  known: boolean;
  until: Map<LimitProvider, Date>;
  /** Providers the proxy reaches on an API key rather than a subscription. */
  keyed: Set<BilledProvider>;
}

/** The proxy's view of which subscriptions are limited, and which are API keys, briefly cached. */
export class ProviderLimits {
  private cached: ({ at: number } & ProxyView) | null = null;
  private readonly config: Config;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async until(provider: LimitProvider): Promise<Date | null> {
    const until = (await this.view()).until.get(provider);
    return until && until.getTime() > Date.now() ? until : null;
  }

  /**
   * Whether the proxy reaches this provider on an API key, so its usage
   * costs money; null when the proxy couldn't be asked.
   */
  async onApiKey(provider: BilledProvider): Promise<boolean | null> {
    const view = await this.view();
    return view.known ? view.keyed.has(provider) : null;
  }

  private async view(): Promise<ProxyView> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > STATUS_TTL_MS) {
      this.cached = { at: now, ...(await this.load()) };
    }
    return this.cached;
  }

  /** Forget the cache, e.g. right before deciding whether a failure was a limit. */
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<ProxyView> {
    const out: ProxyView = { known: false, until: new Map(), keyed: new Set() };
    try {
      const res = await this.fetchImpl(`${this.config.CREDPROXY_URL}/status`, {
        headers: { authorization: `Bearer ${this.config.CREDPROXY_ADMIN_KEY}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return out;
      const statuses = z.array(CredentialStatus).parse(await res.json());
      out.known = true;
      for (const status of statuses) {
        if (status.source === "env") out.keyed.add(status.provider);
        // DeepSeek is an API key, with no subscription limit to wait out.
        if (status.limitedUntil && status.provider !== "deepseek")
          out.until.set(status.provider, new Date(status.limitedUntil));
      }
    } catch {
      // No proxy answer: nothing known to be limited.
    }
    return out;
  }
}

type LimitWaitItem = ThreadItemOf<"limit_wait">;

export interface LimitWaitHooks {
  /** Puts restored turns back on a nibblet's queue without recording them again. */
  restoreQueue(nibbletId: string, turns: WaitingTurn[]): void;
  /** The wait is over: run whatever is queued. */
  resume(nibbletId: string): void;
}

type WaitStore = Pick<Store, "getSetting" | "setSetting" | "getItem" | "putItem" | "setStatus">;

export class LimitWaits {
  private readonly waits = new Map<string, Wait>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly store: WaitStore;
  private readonly hooks: LimitWaitHooks;
  private readonly now: () => Date;

  constructor(store: WaitStore, hooks: LimitWaitHooks, now: () => Date = () => new Date()) {
    this.store = store;
    this.hooks = hooks;
    this.now = now;
  }

  waiting(nibbletId: string): boolean {
    return this.waits.has(nibbletId);
  }

  /** The nibblets waiting, for this reason. */
  waitingFor(reason: WaitReason): string[] {
    return [...this.waits].filter(([, w]) => w.reason === reason).map(([id]) => id);
  }

  /** Re-arms waits saved before a restart, resuming at once any that already passed. */
  async restore(): Promise<void> {
    const saved = await this.store.getSetting(SETTING, (v) => Waits.parse(v), {});
    for (const [nibbletId, wait] of Object.entries(saved)) {
      this.waits.set(nibbletId, wait);
      this.hooks.restoreQueue(nibbletId, wait.turns);
      this.arm(nibbletId, new Date(wait.until));
    }
  }

  /** Starts (or extends) a wait, holding these turns until the limit resets. */
  async start(
    nibbletId: string,
    provider: LimitProvider | null,
    until: Date,
    turns: WaitingTurn[],
    reason: WaitReason = "usage",
  ): Promise<void> {
    const existing = this.waits.get(nibbletId);
    const wait: Wait = {
      reason,
      until: until.toISOString(),
      provider,
      itemId: existing?.itemId ?? newId("limit"),
      turns,
    };
    this.waits.set(nibbletId, wait);
    await this.save();
    await this.putItem(nibbletId, wait, "waiting");
    await this.store.setStatus(
      nibbletId,
      "waiting",
      reason === "budget"
        ? `Monthly budget spent, resuming ${until.toISOString().slice(0, 10)}`
        : `Usage limit reached, resuming at ${clock(until)}`,
    );
    this.arm(nibbletId, until);
  }

  /** Keeps the saved copy of a waiting nibblet's queue current. */
  async saveTurns(nibbletId: string, turns: WaitingTurn[]): Promise<void> {
    const wait = this.waits.get(nibbletId);
    if (!wait) return;
    wait.turns = turns;
    await this.save();
  }

  /** Ends a wait: on time, because the user said "Try now", or cancelled by a stop. */
  async end(nibbletId: string, how: "resumed" | "cancelled"): Promise<void> {
    const wait = this.waits.get(nibbletId);
    if (!wait) return;
    clearTimeout(this.timers.get(nibbletId));
    this.timers.delete(nibbletId);
    this.waits.delete(nibbletId);
    await this.save();
    await this.putItem(nibbletId, wait, how);
    if (how === "resumed") {
      await this.store.setStatus(nibbletId, "idle");
      this.hooks.resume(nibbletId);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(nibbletId: string, until: Date): void {
    clearTimeout(this.timers.get(nibbletId));
    // setTimeout caps at about 24.8 days; re-arm in steps for anything longer.
    const delay = Math.max(0, Math.min(until.getTime() - this.now().getTime(), 2 ** 31 - 1));
    this.timers.set(
      nibbletId,
      setTimeout(() => {
        if (until.getTime() > this.now().getTime()) return this.arm(nibbletId, until);
        void this.end(nibbletId, "resumed").catch((err: unknown) =>
          console.error(`couldn't resume ${nibbletId}`, err),
        );
      }, delay),
    );
  }

  private async save(): Promise<void> {
    await this.store.setSetting(SETTING, Object.fromEntries(this.waits));
  }

  private async putItem(
    nibbletId: string,
    wait: Wait,
    status: LimitWaitItem["status"],
  ): Promise<void> {
    const existing = await this.store.getItem(nibbletId, wait.itemId).catch(() => null);
    await this.store.putItem(nibbletId, {
      type: "limit_wait",
      id: wait.itemId,
      reason: wait.reason,
      turnId: wait.turns[0]?.turnId ?? null,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      provider: wait.provider,
      until: wait.until,
      status,
    });
  }
}

function clock(date: Date): string {
  return date.toISOString().slice(11, 16) + " UTC";
}
