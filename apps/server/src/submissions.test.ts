import { connect, migrateDb, type Db } from "@nibblet/db";
import type { FileRef, LiveMessage, ServerToRunner } from "@nibblet/protocol";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Bus } from "./bus.ts";
import { Conductor, type RunnerLink } from "./conductor.ts";
import { loadConfig } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import { exportState, importState } from "./snapshot-state.ts";
import { Store } from "./store.ts";
import { lockTestDatabase } from "./test-database.ts";

const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe.skipIf(!url)("durable client submissions", () => {
  let db: Db;
  let unlockDatabase: (() => Promise<void>) | undefined;
  let store: Store;
  let conductor: Conductor;
  let id: string;
  let sent: ServerToRunner[];
  let events: LiveMessage[];
  const docker = {
    runners: async () => new Map(),
    runnerOutdated: async () => false,
    watchRunnerExits: async () => undefined,
    startRunner: async () => "test-container",
    stopRunner: async () => undefined,
    stopSubagent: async () => undefined,
  } as unknown as Orchestrator;
  const config = loadConfig({
    NIBBLET_OWNER_TOKEN: "test-owner-token-only",
    CREDPROXY_KEY: "test-proxy-key-only",
    CREDPROXY_ADMIN_KEY: "test-admin-key-only",
  });
  const files = async (): Promise<FileRef[]> => [];

  function makeConductor(): Conductor {
    const result = new Conductor(store, docker, config);
    Object.assign(result, {
      initializing: false,
      paused: true,
      buildSystem: async () => "test system",
      providerLimits: { until: async () => null, invalidate: () => undefined },
    });
    return result;
  }
  async function ready(target = conductor, activeTurnId: string | null = null): Promise<void> {
    const link: RunnerLink = { send: (message) => sent.push(message), close: () => undefined };
    const links = Reflect.get(target, "links") as Map<string, RunnerLink>;
    if (!links.has(id)) links.set(id, link);
    Object.assign(target, { paused: false });
    await target.onRunnerMessage(id, {
      type: "ready",
      harnessVersion: "test",
      activeTurnId,
      viewPort: null,
    });
  }
  const turns = () => sent.filter((m) => m.type === "turn");

  beforeAll(async () => {
    db = connect(url!);
    unlockDatabase = await lockTestDatabase(db);
    await migrateDb(db);
  }, 30_000);
  afterAll(async () => {
    try {
      await unlockDatabase?.();
    } finally {
      await db?.$client.end();
    }
  });
  beforeEach(async () => {
    events = [];
    const bus = new Bus();
    bus.subscribe((event) => events.push(event));
    store = new Store(db, bus, { name: "test", embed: async () => [] });
    id = (
      await store.createNibblet(
        { name: "Test", harness: "claude", model: "claude-haiku-4-5", effort: "medium" },
        null,
      )
    ).nibblet.id;
    await store.setStatus(id, "idle");
    sent = [];
    conductor = makeConductor();
    Object.assign(docker, { runners: async () => new Map() });
  });

  it("returns the original receipt after a lost acknowledgement without validating removed files", async () => {
    await store.updateNibblet(id, { lastActivityAt: new Date("2020-01-01T00:00:00Z") });
    const key = randomUUID();
    const receipt = await conductor.send(id, "hello", ["old-file"], key, files);
    const acceptedAt = (await store.getNibblet(id)).lastActivityAt;
    expect(acceptedAt).not.toBe("2020-01-01T00:00:00.000Z");
    const removed = vi.fn(async () => {
      throw new Error("file gone");
    });
    expect(await conductor.send(id, "hello", ["old-file"], key, removed)).toEqual(receipt);
    expect(removed).not.toHaveBeenCalled();
    expect((await store.getNibblet(id)).lastActivityAt).toBe(acceptedAt);
    expect(
      (await store.itemsSince(id, 0)).filter((r) => r.item.type === "user_message"),
    ).toHaveLength(1);
  });

  it("serialises simultaneous identical IDs and rejects different raw text or attachment order", async () => {
    const key = randomUUID();
    const receipts = await Promise.all(
      Array.from({ length: 5 }, () => conductor.send(id, "hello", ["a", "b"], key, files)),
    );
    expect(new Set(receipts.map((r) => r.turnId)).size).toBe(1);
    await expect(conductor.send(id, "hello ", ["a", "b"], key, files)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(conductor.send(id, "hello", ["b", "a"], key, files)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("dispatches one concurrent distinct ID at a time", async () => {
    await Promise.all([
      conductor.send(id, "one", [], randomUUID(), files),
      conductor.send(id, "two", [], randomUUID(), files),
    ]);
    await Promise.all([ready(), ready()]);
    expect(turns()).toHaveLength(1);
    expect(
      (await store.itemsSince(id, 0)).filter((r) => r.item.type === "user_message"),
    ).toHaveLength(2);
  });

  it("recovers a receipt accepted before the RAM queue survived", async () => {
    const receipt = await conductor.send(id, "original", [], randomUUID(), files);
    const restarted = makeConductor();
    await restarted.reconcile();
    await ready(restarted);
    expect(turns()).toMatchObject([{ turnId: receipt.turnId, input: "original" }]);
  });

  it("commits started plus running marker before runner send and never blindly replays it", async () => {
    const key = randomUUID();
    const receipt = await conductor.send(id, "original", [], key, files);
    await ready();
    expect(await store.submission(id, key)).toMatchObject({ state: "started" });
    expect(await store.getItem(id, receipt.turnId)).toMatchObject({
      type: "turn",
      status: "running",
    });
    const restarted = makeConductor();
    await restarted.reconcile();
    await ready(restarted);
    expect(turns()).toHaveLength(1);
    expect(await restarted.send(id, "original", [], key, files)).toMatchObject({
      turnId: receipt.turnId,
      state: "interrupted",
    });
  });

  it("does not resurrect interrupted queued messages after restart", async () => {
    const key = randomUUID();
    await conductor.send(id, "cancel me", [], key, files);
    await conductor.interrupt(id);
    const restarted = makeConductor();
    await restarted.reconcile();
    await ready(restarted);
    expect(turns()).toHaveLength(0);
    expect(await restarted.send(id, "cancel me", [], key, files)).toMatchObject({
      state: "cancelled",
    });
  });

  it("keeps completed and cancelled receipts across snapshot transcript replacement", async () => {
    const state = await exportState(db, id);
    const doneKey = randomUUID();
    const queuedKey = randomUUID();
    const done = await conductor.send(id, "done", [], doneKey, files);
    await store.setSubmissionState(id, done.turnId, "finished");
    await conductor.send(id, "queued", [], queuedKey, files);
    await importState(db, id, state);
    expect(await conductor.send(id, "done", [], doneKey, files)).toMatchObject({
      state: "finished",
    });
    expect(await conductor.send(id, "queued", [], queuedKey, files)).toMatchObject({
      state: "cancelled",
    });
    await ready();
    expect(turns()).toHaveLength(0);
  });

  it("retains the stable turn and original files through limit waits and duplicate retries", async () => {
    const key = randomUUID();
    const attachment = { fileId: "file-one", name: "one.txt", mime: "text/plain", size: 3 };
    const receipt = await conductor.send(id, "with file", [attachment.fileId], key, async () => [
      attachment,
    ]);
    await ready();
    await conductor.onRunnerMessage(id, {
      type: "turn_end",
      turnId: receipt.turnId,
      status: "failed",
      error: "usage limit reached",
      sessionId: null,
      usage: null,
    });
    expect(await conductor.send(id, "with file", [attachment.fileId], key, files)).toMatchObject({
      state: "queued",
      turnId: receipt.turnId,
    });
    await conductor.resumeNow(id);
    await ready();
    expect(turns()).toMatchObject([
      { turnId: receipt.turnId, input: "with file", attachments: [attachment] },
      { turnId: receipt.turnId, input: "with file", attachments: [attachment] },
    ]);
    expect(
      (await store.itemsSince(id, 0)).filter((r) => r.item.type === "user_message"),
    ).toHaveLength(1);
    conductor.limits.stopAll();
  });

  it("adopts an authenticated running turn with its original input and files for limit recovery", async () => {
    const key = randomUUID();
    const attachment = { fileId: "file-adopt", name: "one.txt", mime: "text/plain", size: 3 };
    const receipt = await conductor.send(
      id,
      "original input",
      [attachment.fileId],
      key,
      async () => [attachment],
    );
    await ready();
    Object.assign(docker, { runners: async () => new Map([[id, { running: true }]]) });
    const restarted = makeConductor();
    await restarted.reconcile();
    await ready(restarted, receipt.turnId);
    expect(turns()).toHaveLength(1);
    await restarted.onRunnerMessage(id, {
      type: "turn_end",
      turnId: receipt.turnId,
      status: "failed",
      error: "usage limit reached",
      sessionId: null,
      usage: null,
    });
    await restarted.resumeNow(id);
    await ready(restarted);
    expect(turns().at(-1)).toMatchObject({
      turnId: receipt.turnId,
      input: "original input",
      attachments: [attachment],
    });
    restarted.limits.stopAll();
  });

  it("holds new submissions throughout a restore while returning existing receipts", async () => {
    const key = randomUUID();
    const waitingKey = randomUUID();
    await conductor.send(id, "old", [], key, files);
    await conductor.beginRestore(id);
    await expect(conductor.send(id, "new", [], waitingKey, files)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await store.submission(id, waitingKey)).toBeNull();
    expect(await conductor.send(id, "old", [], key, files)).toMatchObject({ state: "cancelled" });
    conductor.endRestore(id);
    await expect(conductor.send(id, "new", [], waitingKey, files)).resolves.toMatchObject({
      clientMessageId: waitingKey,
      state: "queued",
    });
  });

  it("clears the restore gate when cancelling submissions fails", async () => {
    const existingKey = randomUUID();
    const waitingKey = randomUUID();
    const existing = await conductor.send(id, "existing queued message", [], existingKey, files);
    const failure = new Error("transient cancellation failure");
    let rejectCancellation!: (error: Error) => void;
    let entered!: () => void;
    const cancelling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    vi.spyOn(store, "cancelSubmissions").mockImplementationOnce(async () => {
      entered();
      await cancelled;
    });
    const restoreFailed = expect(conductor.beginRestore(id)).rejects.toBe(failure);
    await cancelling;
    const waitingRejected = expect(
      conductor.send(id, "waiting message", [], waitingKey, files),
    ).rejects.toMatchObject({ code: "unavailable" });
    rejectCancellation(failure);
    await restoreFailed;
    await waitingRejected;
    expect(await conductor.send(id, "existing queued message", [], existingKey, files)).toEqual(
      existing,
    );
    await expect(
      conductor.send(id, "waiting message", [], waitingKey, files),
    ).resolves.toMatchObject({ clientMessageId: waitingKey, state: "queued" });
    await expect(
      conductor.enqueue(id, "user", "ordinary message after failure"),
    ).resolves.toBeTypeOf("string");
    expect(await store.submission(id, existingKey)).toMatchObject({ state: "queued" });
  });

  it("publishes the committed running marker and atomically commits terminal state", async () => {
    const key = randomUUID();
    const receipt = await conductor.send(id, "hello", [], key, files);
    await ready();
    expect(
      events.some(
        (event) =>
          event.type === "item" &&
          event.item.item.id === receipt.turnId &&
          event.item.item.type === "turn" &&
          event.item.item.status === "running",
      ),
    ).toBe(true);
    await conductor.onRunnerMessage(id, {
      type: "turn_end",
      turnId: receipt.turnId,
      status: "completed",
      error: null,
      sessionId: null,
      usage: null,
    });
    expect(await store.submission(id, key)).toMatchObject({ state: "finished" });
    expect(await store.getItem(id, receipt.turnId)).toMatchObject({ status: "completed" });
  });

  it("retains queued work after a running-marker transaction fails", async () => {
    const key = randomUUID();
    Object.assign(conductor, { wake: async () => undefined });
    await conductor.send(id, "retry preparation", [], key, files);
    vi.spyOn(store, "putSubmissionTurn").mockRejectedValueOnce(
      new Error("transient write failure"),
    );
    await expect(ready()).rejects.toThrow("transient write failure");
    expect(await store.submission(id, key)).toMatchObject({ state: "queued" });
    expect(conductor.activeTurnId(id)).toBeNull();
    await ready();
    expect(turns()).toHaveLength(1);
  });

  it("closes a prepared turn if its runner connection changes before send", async () => {
    const key = randomUUID();
    await conductor.send(id, "connection swap", [], key, files);
    Object.assign(conductor, {
      buildSystem: async () => {
        const links = Reflect.get(conductor, "links") as Map<string, RunnerLink>;
        links.set(id, { send: (message) => sent.push(message), close: () => undefined });
        return "test system";
      },
    });
    await ready();
    expect(conductor.activeTurnId(id)).toBeNull();
    expect(turns()).toHaveLength(0);
    expect(await store.submission(id, key)).toMatchObject({ state: "interrupted" });
  });

  it("wakes accepted queued work after reboot without inventing a runner ready event", async () => {
    await conductor.send(id, "wake after reboot", [], randomUUID(), files);
    const restarted = makeConductor();
    Object.assign(restarted, { paused: false, initializing: true });
    const start = vi.spyOn(restarted, "start").mockImplementation(async (nibbletId) => {
      await store.setStatus(nibbletId, "starting");
      return store.getNibblet(nibbletId);
    });
    await restarted.reconcile();
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(id));
  });

  it("holds runner ready and dispatch until reconciliation finishes", async () => {
    let release!: (value: Map<string, never>) => void;
    Object.assign(docker, {
      runners: () =>
        new Promise<Map<string, never>>((resolve) => {
          release = resolve;
        }),
    });
    Object.assign(conductor, { initializing: true, paused: false });
    const reconciliation = conductor.reconcile();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const key = randomUUID();
    const receipt = await conductor.send(id, "while booting", [], key, files);
    const runnerReady = ready();
    expect(await store.submission(id, key)).toMatchObject({ state: "queued" });
    expect(turns()).toHaveLength(0);
    release(new Map<string, never>());
    await reconciliation;
    await runnerReady;
    expect(conductor.activeTurnId(id)).toBe(receipt.turnId);
    expect(turns()).toHaveLength(1);
  });

  it("keeps recovered queued messages ahead of messages sent during early startup", async () => {
    const old = await conductor.send(id, "accepted before restart", [], randomUUID(), files);
    const restarted = makeConductor();
    Object.assign(restarted, { initializing: true });
    let release!: () => void;
    let entered!: () => void;
    const resetting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reset = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(restarted.approvals, "resetStale").mockImplementationOnce(async () => {
      entered();
      await reset;
    });
    const reconciliation = restarted.reconcile();
    await resetting;
    const lookup = vi.spyOn(store, "submission");
    const newer = restarted.send(id, "sent during restart", [], randomUUID(), files);
    await store.getNibblet(id);
    const attemptedBeforeRecovery = lookup.mock.calls.length;
    release();
    await reconciliation;
    const accepted = await newer;
    expect(attemptedBeforeRecovery).toBe(0);
    await ready(restarted);
    expect(turns()).toMatchObject([{ turnId: old.turnId, input: "accepted before restart" }]);
    await restarted.onRunnerMessage(id, {
      type: "turn_end",
      turnId: old.turnId,
      status: "completed",
      error: null,
      sessionId: null,
      usage: null,
    });
    await ready(restarted);
    expect(turns()).toMatchObject([
      { turnId: old.turnId, input: "accepted before restart" },
      { turnId: accepted.turnId, input: "sent during restart" },
    ]);
  });

  it("restores mixed update queues before accepting messages during runner discovery", async () => {
    const first = await conductor.send(id, "durable first", [], randomUUID(), files);
    const legacy = await conductor.enqueue(id, "user", "legacy middle");
    const third = await conductor.send(id, "durable third", [], randomUUID(), files);
    await conductor.pauseForUpdate();
    const restarted = makeConductor();
    Object.assign(restarted, { initializing: true });
    let release!: (value: Map<string, never>) => void;
    Object.assign(docker, {
      runners: () =>
        new Promise<Map<string, never>>((resolve) => {
          release = resolve;
        }),
    });
    const reconciliation = restarted.reconcile();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const newest = await restarted.send(id, "new during discovery", [], randomUUID(), files);
    release(new Map<string, never>());
    await reconciliation;
    await ready(restarted);
    for (const turnId of [first.turnId, legacy, third.turnId]) {
      expect(turns().at(-1)).toMatchObject({ turnId });
      await restarted.onRunnerMessage(id, {
        type: "turn_end",
        turnId,
        status: "completed",
        error: null,
        sessionId: null,
        usage: null,
      });
      await ready(restarted);
    }
    expect(turns().map((turn) => turn.turnId)).toEqual([
      first.turnId,
      legacy,
      third.turnId,
      newest.turnId,
    ]);
  });

  it("cancels a stopped child's queued receipt without creating generic resume work", async () => {
    const child = (
      await store.createNibblet(
        { name: "Child", harness: "claude", model: "claude-haiku-4-5", effort: "medium" },
        id,
      )
    ).nibblet;
    await store.setStatus(child.id, "idle");
    const key = randomUUID();
    await conductor.send(child.id, "queued child", [], key, files);
    await store.setStatus(child.id, "stopped");
    await conductor.start(id);
    expect(await store.submission(child.id, key)).toMatchObject({ state: "cancelled" });
    expect(
      (await store.itemsSince(child.id, 0)).filter((row) => row.item.type === "user_message"),
    ).toHaveLength(1);
    expect(conductor.busy(child.id)).toBe(false);
  });

  it("waits for a disconnected turn's terminal transaction before restoring its transcript", async () => {
    const empty = await exportState(db, id);
    const receipt = await conductor.send(id, "before restore", [], randomUUID(), files);
    await ready();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.putSubmissionTurn.bind(store);
    vi.spyOn(store, "putSubmissionTurn").mockImplementationOnce(async (...args) => {
      entered();
      await held;
      await original(...args);
    });
    const links = Reflect.get(conductor, "links") as Map<string, RunnerLink>;
    const detached = conductor.detach(id, links.get(id)!);
    await started;
    let restored = false;
    const restoring = conductor.beginRestore(id).then(() => {
      restored = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restored).toBe(false);
    release();
    await detached;
    await restoring;
    await importState(db, id, empty);
    conductor.endRestore(id);
    expect(await store.getItem(id, receipt.turnId)).toBeNull();
    expect(await store.submissionForTurn(id, receipt.turnId)).toMatchObject({ state: "finished" });
  });

  it("rolls back receipt state when terminal marker serialisation fails inside its transaction", async () => {
    const key = randomUUID();
    const receipt = await conductor.send(id, "transaction rollback", [], key, files);
    await ready();
    const item = await store.getItem(id, receipt.turnId);
    if (item?.type !== "turn") throw new Error("Missing running marker");
    const failing = Object.assign(
      { ...item, status: "completed" as const },
      {
        toJSON() {
          throw new Error("injected marker serialisation failure");
        },
      },
    );
    await expect(store.putSubmissionTurn(id, failing, "finished")).rejects.toThrow();
    expect(await store.submission(id, key)).toMatchObject({ state: "started" });
    expect(await store.getItem(id, receipt.turnId)).toMatchObject({ status: "running" });
  });

  it("orders an in-flight limit resume before restoring the transcript", async () => {
    const empty = await exportState(db, id);
    const receipt = await conductor.send(id, "limit before restore", [], randomUUID(), files);
    await ready();
    await conductor.onRunnerMessage(id, {
      type: "turn_end",
      turnId: receipt.turnId,
      status: "failed",
      error: "usage limit reached",
      sessionId: null,
      usage: null,
    });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.setSetting.bind(store);
    vi.spyOn(store, "setSetting").mockImplementationOnce(async (...args) => {
      entered();
      await held;
      await original(...args);
    });
    const resuming = conductor.resumeNow(id);
    await started;
    let restored = false;
    const restoring = conductor.beginRestore(id).then(() => {
      restored = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restored).toBe(false);
    release();
    await resuming;
    await restoring;
    await importState(db, id, empty);
    conductor.endRestore(id);
    expect((await store.itemsSince(id, 0)).some((row) => row.item.type === "limit_wait")).toBe(
      false,
    );
    conductor.limits.stopAll();
  });
});
