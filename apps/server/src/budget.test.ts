import type { Nibblet } from "@nibblets/protocol";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Budgets, mountBudgets } from "./budget.ts";

const ADMIN = "admin-key-0123456789";

function fakeStore(nibblets: Pick<Nibblet, "id" | "parentId" | "monthlyBudgetUsd">[]) {
  const spent = new Map<string, number>();
  return {
    spent,
    async getNibblet(id: string) {
      const n = nibblets.find((x) => x.id === id);
      if (!n) throw new Error(`No nibblet ${id}`);
      return n as Nibblet;
    },
    async spentUsd(id: string, month: string) {
      return spent.get(`${id}/${month}`) ?? 0;
    },
    async addSpend(id: string, month: string, cost: number) {
      const total = (spent.get(`${id}/${month}`) ?? 0) + cost;
      spent.set(`${id}/${month}`, total);
      return total;
    },
  };
}

const opusMillionOut = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 1_000_000,
  webSearches: 0,
};

describe("Budgets", () => {
  const now = () => new Date("2026-10-21T12:00:00Z");

  it("adds up a month's spending and stops at the budget", async () => {
    const store = fakeStore([{ id: "nib_a", parentId: null, monthlyBudgetUsd: 30 }]);
    const budgets = new Budgets(store, now);
    const one = { nibbletId: "nib_a", provider: "anthropic" as const, model: "claude-opus-5-5" };
    expect(await budgets.record({ ...one, usage: opusMillionOut })).toMatchObject({
      spentUsd: 20,
      allowed: true,
      month: "2026-10",
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    expect(await budgets.record({ ...one, usage: opusMillionOut })).toMatchObject({
      spentUsd: 40,
      budgetUsd: 30,
      allowed: false,
    });
  });

  it("counts a sub-agent's spending against the nibblet at the top of its tree", async () => {
    const store = fakeStore([
      { id: "nib_top", parentId: null, monthlyBudgetUsd: 5 },
      { id: "nib_child", parentId: "nib_top", monthlyBudgetUsd: null },
      { id: "nib_grandchild", parentId: "nib_child", monthlyBudgetUsd: null },
    ]);
    const budgets = new Budgets(store, now);
    await budgets.record({
      nibbletId: "nib_grandchild",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: opusMillionOut,
    });
    expect(store.spent.get("nib_top/2026-10")).toBe(20);
    expect(await budgets.status("nib_child")).toMatchObject({
      nibbletId: "nib_top",
      allowed: false,
    });
  });

  it("allows anything without a budget", async () => {
    const budgets = new Budgets(
      fakeStore([{ id: "nib_a", parentId: null, monthlyBudgetUsd: null }]),
      now,
    );
    expect((await budgets.status("nib_a")).allowed).toBe(true);
  });
});

describe("mountBudgets", () => {
  function setup() {
    const app = new Hono();
    const store = fakeStore([{ id: "nib_a", parentId: null, monthlyBudgetUsd: 1 }]);
    mountBudgets(app, { config: { CREDPROXY_ADMIN_KEY: ADMIN }, budgets: new Budgets(store) });
    return { app, store };
  }

  it("answers the proxy, and only the proxy", async () => {
    const { app } = setup();
    expect((await app.request("/credproxy/budget/nib_a")).status).toBe(401);
    const res = await app.request("/credproxy/budget/nib_a", {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(await res.json()).toMatchObject({ nibbletId: "nib_a", budgetUsd: 1, allowed: true });
    expect(
      (
        await app.request("/credproxy/budget/nib_nope", {
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).status,
    ).toBe(404);
  });

  it("records reported usage, refusing anything malformed", async () => {
    const { app, store } = setup();
    const post = (body: unknown, key = ADMIN) =>
      app.request("/credproxy/usage", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const report = {
      nibbletId: "nib_a",
      provider: "openai",
      model: "gpt-6-luna",
      usage: { ...opusMillionOut, outputTokens: 4_000_000 },
    };
    expect((await post(report, "wrong")).status).toBe(401);
    expect((await post({ ...report, usage: { outputTokens: -1 } })).status).toBe(400);
    const res = await post(report);
    expect(await res.json()).toMatchObject({ spentUsd: 2, allowed: false });
    expect([...store.spent.values()]).toEqual([2]);
  });
});
