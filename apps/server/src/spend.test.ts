import { connect, EMBEDDING_DIMENSIONS, migrateDb, type Db } from "@nibblets/db";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budget.ts";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";

/** Needs Postgres with pgvector: see snapshots.test.ts. */
const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe.skipIf(!url)("spending on API keys", () => {
  let db: Db;
  let store: Store;
  let pip: string;

  beforeAll(async () => {
    // A database of its own, so the other database tests can't empty its tables.
    const admin = connect(url ?? "");
    const exists = await admin.execute(
      sql`SELECT 1 FROM pg_database WHERE datname = 'nibblet_spend_test'`,
    );
    if (exists.length === 0) await admin.execute(sql`CREATE DATABASE nibblet_spend_test`);
    await admin.$client.end();
    const own = new URL(url ?? "");
    own.pathname = "/nibblet_spend_test";
    db = connect(own.toString());
    await migrateDb(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE nibblets CASCADE`);
    store = new Store(db, new Bus(), {
      name: "test",
      embed: async (texts) =>
        texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)),
    });
    pip = (
      await store.createNibblet(
        { name: "Pip", harness: "claude", model: "claude-opus-5-5", effort: "medium" },
        null,
      )
    ).nibblet.id;
  });

  it("adds each request to its month, and keeps months apart", async () => {
    expect(await store.spentUsd(pip, "2026-10")).toBe(0);
    expect(await store.addSpend(pip, "2026-10", 1.25)).toBe(1.25);
    expect(await store.addSpend(pip, "2026-10", 0.5)).toBe(1.75);
    await store.addSpend(pip, "2026-11", 3);
    expect(await store.spentUsd(pip, "2026-10")).toBe(1.75);
    expect(await store.spentUsd(pip, "2026-11")).toBe(3);
  });

  it("keeps the budget on the nibblet, and checks spending against it", async () => {
    const updated = await store.updateNibblet(pip, { monthlyBudgetUsd: 2 });
    expect(updated.monthlyBudgetUsd).toBe(2);
    const budgets = new Budgets(store, () => new Date("2026-10-21T00:00:00Z"));
    await store.addSpend(pip, "2026-10", 1.99);
    expect((await budgets.status(pip)).allowed).toBe(true);
    await store.addSpend(pip, "2026-10", 0.01);
    expect(await budgets.status(pip)).toMatchObject({ allowed: false, spentUsd: 2 });
  });

  it("goes when the nibblet does", async () => {
    await store.addSpend(pip, "2026-10", 1);
    await store.deleteNibblet(pip);
    expect(await store.spentUsd(pip, "2026-10")).toBe(0);
  });
});
