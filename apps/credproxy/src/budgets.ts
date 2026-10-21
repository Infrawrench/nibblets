import { BudgetStatus, type MeteredRequest } from "@nibblet/protocol";

/**
 * The server keeps nibblets' budgets and what they've spent; the proxy asks
 * it before relaying a request on an API key, and tells it what each used.
 */
export interface BudgetClient {
  check(nibbletId: string): Promise<BudgetStatus>;
  report(request: MeteredRequest): Promise<void>;
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
    },
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Why a request was refused, in words that reach the person through the harness's error. */
export function budgetSpentMessage(status: BudgetStatus): string {
  const resumes = status.resetsAt.slice(0, 10);
  return `This nibblet has spent its monthly budget (${usd(status.spentUsd)} of ${usd(status.budgetUsd ?? 0)}). It carries on ${resumes}, or sooner if the budget is raised in its settings.`;
}
