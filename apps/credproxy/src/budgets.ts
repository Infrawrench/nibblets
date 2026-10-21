import {
  apiCostUsd,
  BudgetStatus,
  type BilledProvider,
  type MeteredRequest,
} from "@nibblets/protocol";
import type { Metered } from "./meter.ts";

/**
 * The server keeps nibblets' budgets and what they've spent; the proxy asks
 * it what a nibblet has left, and tells it what each request used.
 */
export interface BudgetClient {
  check(nibbletId: string): Promise<BudgetStatus>;
  /** Records a request's usage; answers with the nibblet's status after it. */
  report(request: MeteredRequest): Promise<BudgetStatus>;
}

export function serverBudgets(opts: {
  serverUrl: string;
  adminKey: string;
  fetch?: typeof globalThis.fetch;
}): BudgetClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.serverUrl.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${opts.adminKey}` };
  return {
    async check(nibbletId) {
      const res = await doFetch(`${base}/credproxy/budget/${encodeURIComponent(nibbletId)}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return BudgetStatus.parse(await res.json());
    },
    async report(request) {
      const res = await doFetch(`${base}/credproxy/usage`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return BudgetStatus.parse(await res.json());
    },
  };
}

/** How long a nibblet's status from the server is used before asking again. */
const FRESH_MS = 5_000;
/** How long one is still used while the server can't be asked (it's restarting, say). */
const STALE_MS = 5 * 60_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** A request on an API key, from before it's sent until the server has counted it. */
export interface Spending {
  /** What it has used so far, as the response says it. */
  progress(metered: Metered): void;
  /** It's over: report what it used, or nothing (null) if it cost nothing. */
  finish(metered: Metered | null): void;
}

type Verdict = { allowed: true } | { allowed: false; status: BudgetStatus; spentUsd: number };

/**
 * Whether a nibblet may spend more, counting what the server knows and what
 * it doesn't yet: requests still under way (at a guess until their responses
 * say), and finished ones whose reports haven't landed. Without that, several
 * requests at once would each see the same room left, and a report lost to a
 * server restart would never count. A report that fails is kept and tried
 * again until the server takes it.
 */
export class BudgetGate {
  private readonly client: BudgetClient;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly statuses = new Map<string, { status: BudgetStatus; at: number }>();
  /** What each nibblet has spent that the server doesn't know about yet. */
  private readonly pending = new Map<string, Map<symbol, number>>();
  private readonly log: (message: string) => void;

  constructor(
    client: BudgetClient,
    opts: { now?: () => number; retryMs?: number; log?: (message: string) => void } = {},
  ) {
    this.client = client;
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? RETRY_MIN_MS;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** Throws when the server can't be asked and nothing recent is known. */
  async check(nibbletId: string): Promise<Verdict> {
    const status = await this.status(nibbletId);
    const spentUsd = status.spentUsd + this.unreported(nibbletId);
    if (status.budgetUsd === null || spentUsd < status.budgetUsd) return { allowed: true };
    return { allowed: false, status, spentUsd };
  }

  /** Starts counting a request, at `estimate` until its response says what it used. */
  begin(nibbletId: string, provider: BilledProvider, estimate: Metered | null): Spending {
    const id = Symbol(nibbletId);
    const mine = this.pending.get(nibbletId) ?? new Map<symbol, number>();
    this.pending.set(nibbletId, mine);
    const cost = (m: Metered) => apiCostUsd(provider, m.model, m.usage);
    mine.set(id, estimate ? cost(estimate) : 0);
    const forget = () => {
      mine.delete(id);
      if (mine.size === 0) this.pending.delete(nibbletId);
    };
    let finished = false;
    return {
      progress: (metered) => {
        if (!finished) mine.set(id, cost(metered));
      },
      finish: (metered) => {
        if (finished) return;
        finished = true;
        if (!metered) return forget();
        mine.set(id, cost(metered));
        void this.report({ nibbletId, provider, ...metered }, forget);
      },
    };
  }

  private async report(request: MeteredRequest, done: () => void): Promise<void> {
    for (let delay = this.retryMs; ; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
      const sent = this.now();
      try {
        const status = await this.client.report(request);
        // It counts on the server now, and not here.
        this.remember(status, sent);
        done();
        return;
      } catch (err) {
        this.log(
          `couldn't report ${request.nibbletId}'s usage, trying again in ${delay / 1000}s: ${String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delay).unref?.());
      }
    }
  }

  private async status(nibbletId: string): Promise<BudgetStatus> {
    const known = this.statuses.get(nibbletId);
    if (known && this.now() - known.at < FRESH_MS) return known.status;
    const asked = this.now();
    try {
      const status = await this.client.check(nibbletId);
      this.remember(status, asked);
      return status;
    } catch (err) {
      if (known && this.now() - known.at < STALE_MS) return known.status;
      throw err;
    }
  }

  /** Keeps a status, unless one asked for later is already kept. */
  private remember(status: BudgetStatus, at: number): void {
    const known = this.statuses.get(status.nibbletId);
    if (!known || known.at <= at) this.statuses.set(status.nibbletId, { status, at });
  }

  private unreported(nibbletId: string): number {
    let total = 0;
    for (const cost of this.pending.get(nibbletId)?.values() ?? []) total += cost;
    return total;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Why a request was refused, in words that reach the person through the harness's error. */
export function budgetSpentMessage(status: BudgetStatus, spentUsd = status.spentUsd): string {
  const resumes = status.resetsAt.slice(0, 10);
  return `This nibblet has spent its monthly budget (${usd(spentUsd)} of ${usd(status.budgetUsd ?? 0)}). It carries on ${resumes}, or sooner if the budget is raised in its settings.`;
}
