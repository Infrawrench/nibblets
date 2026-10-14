import { connect, EMBEDDING_DIMENSIONS, migrateDb, type Db } from "@nibblet/db";
import type { LiveMessage, ThreadItem } from "@nibblet/protocol";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, type Readable } from "node:stream";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.ts";
import { exportState, importState, settle } from "./snapshot-state.ts";
import { KEEP_BEFORE_RESTORE, Snapshots, type HomeArchiver } from "./snapshots.ts";
import { Store } from "./store.ts";

/**
 * These need a Postgres with pgvector, e.g.
 * `docker run -d -e POSTGRES_PASSWORD=t -p 55432:5432 pgvector/pgvector:0.8.7-pg18` and
 * `NIBBLET_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres`.
 */
const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe("settle", () => {
  it("ends anything that was in flight", () => {
    const base = { id: "i", turnId: "t", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(settle({ ...base, type: "assistant_message", text: "hi", streaming: true })).toEqual({
      ...base,
      type: "assistant_message",
      text: "hi",
      streaming: false,
    });
    const done: ThreadItem = { ...base, type: "user_message", text: "hi", source: "user" };
    expect(settle(done)).toBe(done);
  });
});

/** A home folder that's just a string, so restores can be checked without Docker. */
class FakeHome implements HomeArchiver {
  contents = new Map<string, string>();
  async archiveHome(nibbletId: string, out: Writable): Promise<void> {
    out.write(this.contents.get(nibbletId) ?? "");
  }
  async restoreHome(nibbletId: string, archive: Readable): Promise<void> {
    let text = "";
    for await (const chunk of archive) text += String(chunk);
    this.contents.set(nibbletId, text);
  }
}

describe.skipIf(!url)("snapshots", () => {
  let db: Db;
  let store: Store;
  let bus: Bus;
  let home: FakeHome;
  let dataDir: string;
  let snapshots: Snapshots;
  let busy = false;
  const started: string[] = [];
  const messages: LiveMessage[] = [];
  const vector = (x: number) =>
    Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? x : 0));

  beforeAll(async () => {
    db = connect(url ?? "");
    await migrateDb(db);
    dataDir = await mkdtemp(join(tmpdir(), "nibblet-snapshots-"));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE nibblets, memories, items, schedules, snapshots, settings CASCADE`,
    );
    bus = new Bus();
    bus.subscribe((m) => messages.push(m));
    messages.length = 0;
    started.length = 0;
    busy = false;
    store = new Store(db, bus, {
      name: "test",
      embed: async (texts) => texts.map(() => vector(1)),
    });
    home = new FakeHome();
    snapshots = new Snapshots({
      store,
      bus,
      docker: home,
      conductor: {
        busy: () => busy,
        interrupt: () => {
          busy = false;
        },
        start: async (id) => {
          started.push(id);
          await store.setStatus(id, "idle");
        },
        stop: (id) => store.setStatus(id, "stopped"),
      },
      scheduler: { arm: async () => undefined, disarm: () => undefined },
      dataDir,
      idleTimeoutMs: 200,
      pollMs: 10,
    });
  });

  const make = async () => {
    const { nibblet } = await store.createNibblet(
      { name: "Pip", harness: "claude", model: "claude-haiku-4-5", effort: "medium" },
      null,
    );
    await store.setStatus(nibblet.id, "idle");
    return nibblet.id;
  };
  const say = (id: string, text: string) =>
    store.putItem(id, {
      id: `msg-${text}`,
      turnId: null,
      createdAt: new Date().toISOString(),
      type: "user_message",
      text,
      source: "user",
    });
  const texts = async (id: string) =>
    (await store.itemsSince(id, 0)).map((s) => (s.item.type === "user_message" ? s.item.text : ""));

  it("round-trips state with fresh seqs and leaves shared memories alone", async () => {
    const id = await make();
    await say(id, "one");
    await say(id, "two");
    await store.saveMemory({ nibbletId: id, content: "own", tags: [] });
    await store.saveMemory({ nibbletId: null, content: "shared", tags: [] });
    const state = await exportState(db, id);
    const oldSeqs = state.items.map((r) => r.seq);

    await say(id, "three");
    await store.saveMemory({ nibbletId: id, content: "own later", tags: [] });
    await store.saveMemory({ nibbletId: null, content: "shared later", tags: [] });
    await store.updateNibblet(id, { instructions: "changed", harnessSessionId: "s" });

    await importState(db, id, state);
    const after = await store.itemsSince(id, 0);
    expect(after.map((s) => s.item.id)).toEqual(["msg-one", "msg-two"]);
    expect(Math.min(...after.map((s) => s.seq))).toBeGreaterThan(Math.max(...oldSeqs));
    const own = await store.searchMemories({ nibbletId: id, limit: 50 });
    expect(own.map((m) => m.content).sort()).toEqual(["own", "shared", "shared later"]);
    const row = await store.nibbletRow(id);
    expect(row.instructions).toBe("");
    expect(row.harnessSessionId).toBeNull();
  });

  it("restores back and forward, saving the present first", async () => {
    const id = await make();
    home.contents.set(id, "file A");
    await say(id, "one");
    const a = await snapshots.create(id, "A");
    home.contents.set(id, "file B");
    await say(id, "two");
    const b = await snapshots.create(id, null);
    expect(b.messageCount).toBe(2);

    await snapshots.restore(a.id);
    expect(home.contents.get(id)).toBe("file A");
    expect(await texts(id)).toEqual(["one"]);
    expect(messages.some((m) => m.type === "thread_reset" && m.nibbletId === id)).toBe(true);
    expect(started).toEqual([id]);
    let timeline = await snapshots.list(id);
    expect(timeline.current).toEqual({ snapshotId: a.id, changedSince: false });
    const before = timeline.snapshots.find((s) => s.trigger === "before_restore");
    expect(before?.label).toBe("Before restoring “A”");

    await snapshots.restore(b.id);
    expect(home.contents.get(id)).toBe("file B");
    expect(await texts(id)).toEqual(["one", "two"]);
    await say(id, "three");
    timeline = await snapshots.list(id);
    expect(timeline.current).toEqual({ snapshotId: b.id, changedSince: true });
    expect(timeline.snapshots.filter((s) => s.trigger === "before_restore")).toHaveLength(2);
  });

  it("doesn't start a nibblet that was stopped", async () => {
    const id = await make();
    await say(id, "one");
    const a = await snapshots.create(id, null);
    await store.setStatus(id, "stopped");
    await snapshots.restore(a.id);
    expect(started).toEqual([]);
    expect((await store.getNibblet(id)).status).toBe("stopped");
  });

  it("waits for a turn, then gives up", async () => {
    const id = await make();
    await say(id, "one");
    busy = true;
    await expect(snapshots.create(id, null)).rejects.toThrow(/still busy/);
  });

  it("takes automatic snapshots when due and changed, keeping the newest few", async () => {
    const id = await make();
    await store.updateNibblet(id, { snapshotPolicy: { everyMinutes: 60, keep: 2 } });
    const hour = 60 * 60_000;
    let now = Date.now();

    await snapshots.tick(new Date(now));
    expect((await snapshots.list(id)).snapshots).toHaveLength(0); // nothing in it yet

    await say(id, "one");
    await snapshots.tick(new Date(now));
    expect((await snapshots.list(id)).snapshots).toHaveLength(1);

    await say(id, "two");
    await snapshots.tick(new Date(now + 10 * 60_000));
    expect((await snapshots.list(id)).snapshots).toHaveLength(1); // not due yet

    // Snapshot times come from the database, so step "now" past them.
    for (const text of ["three", "four", "five"]) {
      now += 2 * hour;
      await say(id, text);
      busy = true;
      await snapshots.tick(new Date(now));
      busy = false;
      await snapshots.tick(new Date(now));
    }
    await snapshots.create(id, "kept");
    const list = (await snapshots.list(id)).snapshots;
    expect(list.filter((s) => s.trigger === "auto").map((s) => s.messageCount)).toEqual([5, 4]);
    expect(list.filter((s) => s.trigger === "manual")).toHaveLength(1);

    await snapshots.tick(new Date(now + 3 * hour));
    expect((await snapshots.list(id)).snapshots).toHaveLength(3); // unchanged since
    const files = await readdir(join(dataDir, "snapshots", id));
    expect(files).toHaveLength(6);
  });

  it("caps before-restore snapshots and cleans up with the nibblet", async () => {
    const id = await make();
    await say(id, "one");
    const a = await snapshots.create(id, null);
    for (let i = 0; i < KEEP_BEFORE_RESTORE + 2; i++) await snapshots.restore(a.id);
    const list = (await snapshots.list(id)).snapshots;
    expect(list.filter((s) => s.trigger === "before_restore")).toHaveLength(KEEP_BEFORE_RESTORE);
    expect(list.some((s) => s.id === a.id)).toBe(true);

    snapshots.start();
    await store.deleteNibblet(id);
    await new Promise((r) => setTimeout(r, 50));
    snapshots.stop();
    await expect(readdir(join(dataDir, "snapshots", id))).rejects.toThrow();
  });
});
