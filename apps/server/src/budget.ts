import {
  apiCostUsd,
  budgetMonth,
  budgetResetsAt,
  MeteredRequest,
  type BudgetStatus,
  type Nibblet,
} from "@nibblet/protocol";
import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

type BudgetStore = Pick<Store, "getNibblet" | "spentUsd" | "addSpend">;

/**
 * Monthly budgets for API-key usage (see `@nibblet/protocol`'s budget.ts).
 * The credential proxy asks here before relaying each request on an API key,
 * and reports what each one used afterwards. A sub-agent runs in its host's
 * container, where the host's agent could read its proxy key anyway, so it
 * spends its host's budget.
 */
export class Budgets {
  private readonly store: BudgetStore;
  private readonly now: () => Date;

  constructor(store: BudgetStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  /** The nibblet whose budget this one spends: the top of its tree. */
  async owner(nibbletId: string): Promise<Nibblet> {
    let n = await this.store.getNibblet(nibbletId);
    while (n.parentId) n = await this.store.getNibblet(n.parentId);
    return n;
  }

  async status(nibbletId: string): Promise<BudgetStatus> {
    const owner = await this.owner(nibbletId);
    const month = budgetMonth(this.now());
    return this.describe(owner, month, await this.store.spentUsd(owner.id, month));
  }

  /** Adds what one request cost to its nibblet's month. */
  async record(request: MeteredRequest): Promise<BudgetStatus> {
    const owner = await this.owner(request.nibbletId);
    const month = budgetMonth(this.now());
    const cost = apiCostUsd(request.provider, request.model, request.usage);
    const spent =
      cost > 0
        ? await this.store.addSpend(owner.id, month, cost)
        : await this.store.spentUsd(owner.id, month);
    return this.describe(owner, month, spent);
  }

  private describe(owner: Nibblet, month: string, spentUsd: number): BudgetStatus {
    const budgetUsd = owner.monthlyBudgetUsd;
    return {
      nibbletId: owner.id,
      budgetUsd,
      spentUsd,
      month,
      resetsAt: budgetResetsAt(this.now()).toISOString(),
      allowed: budgetUsd === null || spentUsd < budgetUsd,
    };
  }
}

/**
 * The routes the credential proxy calls, with the admin key the server and
 * the proxy share. Runners never have that key.
 */
export function mountBudgets(
  app: Hono,
  deps: { config: Pick<Config, "CREDPROXY_ADMIN_KEY">; budgets: Budgets },
): void {
  const authorised = (header: string | undefined) => {
    const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "");
    const want = Buffer.from(deps.config.CREDPROXY_ADMIN_KEY);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  app.get("/credproxy/budget/:id", async (c) => {
    if (!authorised(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    try {
      return c.json(await deps.budgets.status(c.req.param("id")));
    } catch {
      return c.json({ error: "no such nibblet" }, 404);
    }
  });

  app.post("/credproxy/usage", async (c) => {
    if (!authorised(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const body = MeteredRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    try {
      return c.json(await deps.budgets.record(body.data));
    } catch {
      return c.json({ error: "no such nibblet" }, 404);
    }
  });
}
