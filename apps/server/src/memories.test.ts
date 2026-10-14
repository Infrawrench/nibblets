import { connect, EMBEDDING_DIMENSIONS, migrateDb, type Db } from "@nibblet/db";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.ts";
import { Store } from "./store.ts";

/** Needs Postgres with pgvector: see snapshots.test.ts. */
const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe.skipIf(!url)("shared memories", () => {
  let db: Db;
  let store: Store;
  let pip: string;
  let mochi: string;
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));

  beforeAll(async () => {
    // A database of its own, so the snapshot tests running alongside can't
    // empty the tables under these.
    const admin = connect(url ?? "");
    const exists = await admin.execute(
      sql`SELECT 1 FROM pg_database WHERE datname = 'nibblet_memories_test'`,
    );
    if (exists.length === 0) await admin.execute(sql`CREATE DATABASE nibblet_memories_test`);
    await admin.$client.end();
    const own = new URL(url ?? "");
    own.pathname = "/nibblet_memories_test";
    db = connect(own.toString());
    await migrateDb(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE nibblets, memories CASCADE`);
    store = new Store(db, new Bus(), {
      name: "test",
      embed: async (texts) => texts.map(() => vector),
    });
    const make = async (name: string) =>
      (
        await store.createNibblet(
          { name, harness: "claude", model: "claude-opus-5-5", effort: "medium" },
          null,
        )
      ).nibblet.id;
    pip = await make("Pip");
    mochi = await make("Mochi");
  });

  it("keeps another nibblet's shared notes out of what's put in a prompt unasked", async () => {
    await store.saveMemory({ nibbletId: null, content: "From the person", tags: [] });
    await store.saveMemory({ nibbletId: null, sharedBy: pip, content: "From Pip", tags: [] });
    await store.saveMemory({ nibbletId: mochi, content: "Mochi's own", tags: [] });

    const trusted = await store.searchMemories({ nibbletId: mochi, trustedOnly: true });
    expect(trusted.map((m) => m.content).sort()).toEqual(["From the person", "Mochi's own"]);

    // Searched for, it's there, with who shared it.
    const all = await store.searchMemories({ nibbletId: mochi });
    expect(all.find((m) => m.content === "From Pip")?.sharedBy).toBe(pip);

    // Pip's own shared note still reaches Pip's prompt.
    const pips = await store.searchMemories({ nibbletId: pip, trustedOnly: true });
    expect(pips.map((m) => m.content)).toContain("From Pip");
  });

  it("lets a nibblet forget only its own notes and what it shared", async () => {
    const person = await store.saveMemory({ nibbletId: null, content: "Person", tags: [] });
    const pipShared = await store.saveMemory({
      nibbletId: null,
      sharedBy: pip,
      content: "Pip shared",
      tags: [],
    });
    const mochiOwn = await store.saveMemory({ nibbletId: mochi, content: "Mochi", tags: [] });

    expect(await store.deleteMemory(person.id, mochi)).toBe(false);
    expect(await store.deleteMemory(pipShared.id, mochi)).toBe(false);
    expect(await store.deleteMemory(pipShared.id, pip)).toBe(true);
    expect(await store.deleteMemory(mochiOwn.id, mochi)).toBe(true);
    // The person can delete anything.
    expect(await store.deleteMemory(person.id)).toBe(true);
  });

  it("finds turns still marked running, for the server to close after a restart", async () => {
    const turn = (id: string, status: "running" | "completed") => ({
      type: "turn" as const,
      id,
      turnId: id,
      createdAt: new Date().toISOString(),
      source: "user" as const,
      status,
      quiet: false,
      usage: null,
      endedAt: status === "running" ? null : new Date().toISOString(),
    });
    await store.putItem(pip, turn("turn_a", "completed"));
    await store.putItem(pip, turn("turn_b", "running"));
    await store.putItem(mochi, turn("turn_c", "running"));
    const running = await store.runningTurnItems();
    expect(running.map((r) => `${r.nibbletId}:${r.item.id}`).sort()).toEqual(
      [`${mochi}:turn_c`, `${pip}:turn_b`].sort(),
    );
  });
});
