import { snapshots as snapshotsTable } from "@nibblets/db";
import {
  RpcError,
  type Snapshot,
  type SnapshotActivity,
  type SnapshotTimeline,
  type SnapshotTrigger,
} from "@nibblets/protocol";
import { desc, eq } from "drizzle-orm";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { Bus } from "./bus.ts";
import { exportState, importState, maxSeq, messageCount, SnapshotState } from "./snapshot-state.ts";
import { newId, type Store } from "./store.ts";

type SnapshotRow = typeof snapshotsTable.$inferSelect;

/** What snapshots need from a nibblet's machine: copying its home folder out and back in. */
export interface HomeArchiver {
  archiveHome(nibbletId: string, out: Writable): Promise<void>;
  restoreHome(nibbletId: string, archive: Readable): Promise<void>;
}

/** What snapshots need from the conductor, to quiet a nibblet before touching it. */
export interface Quieter {
  busy(nibbletId: string): boolean;
  interrupt(nibbletId: string): void;
  start(nibbletId: string): Promise<unknown>;
  stop(nibbletId: string): Promise<unknown>;
}

/** What snapshots need from the scheduler, to swap a nibblet's schedules. */
export interface ScheduleArmer {
  arm(id: string): Promise<void>;
  disarm(id: string): void;
}

export interface SnapshotDeps {
  store: Store;
  bus: Bus;
  homes: HomeArchiver;
  conductor: Quieter;
  scheduler: ScheduleArmer;
  dataDir: string;
  /** How long a snapshot waits for a turn to finish; tests shorten it. */
  idleTimeoutMs?: number;
  pollMs?: number;
}

const TICK_MS = 60_000;
/** Before-restore snapshots are a safety net, not an archive: keep the newest few. */
export const KEEP_BEFORE_RESTORE = 10;

/** Where the nibblet was last restored to, kept in settings. */
const Position = z.object({ snapshotId: z.string(), maxSeq: z.number() });
type Position = z.infer<typeof Position>;
const positionKey = (nibbletId: string) => `snapshot-position:${nibbletId}`;

const toSnapshot = (row: SnapshotRow): Snapshot => ({
  id: row.id,
  nibbletId: row.nibbletId,
  createdAt: row.createdAt.toISOString(),
  label: row.label,
  trigger: row.trigger,
  sizeBytes: row.sizeBytes,
  messageCount: row.messageCount,
});

const when = (d: Date) =>
  d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

/**
 * Snapshots of a nibblet: its home folder as a gzipped tar and its state as
 * gzipped JSON, side by side under `snapshots/<nibbletId>/` on the data
 * volume, with a row each for listing. Restoring takes a snapshot of the
 * present first, so going back can always be undone by going forward.
 */
export class Snapshots {
  private readonly d: SnapshotDeps;
  private readonly root: string;
  private readonly activity = new Map<string, NonNullable<SnapshotActivity>>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: SnapshotDeps) {
    this.d = deps;
    this.root = join(deps.dataDir, "snapshots");
  }

  start(): void {
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.unsubscribe = this.d.bus.subscribe((m) => {
      if (m.type === "nibblet_deleted") void this.forget(m.id);
    });
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.unsubscribe?.();
  }

  async list(nibbletId: string): Promise<SnapshotTimeline> {
    await this.d.store.getNibblet(nibbletId);
    const rows = await this.rows(nibbletId);
    const position = await this.position(nibbletId);
    const at = position && rows.some((r) => r.id === position.snapshotId) ? position : null;
    return {
      snapshots: rows.map(toSnapshot),
      current: at
        ? {
            snapshotId: at.snapshotId,
            changedSince: (await maxSeq(this.d.store.db, nibbletId)) > at.maxSeq,
          }
        : null,
      activity: this.activity.get(nibbletId) ?? null,
    };
  }

  /** Takes a snapshot, waiting for the nibblet to finish what it's doing first. */
  async create(nibbletId: string, label: string | null): Promise<Snapshot> {
    await this.d.store.getNibblet(nibbletId);
    return this.exclusively(nibbletId, "snapshotting", async () => {
      await this.waitIdle(nibbletId);
      return toSnapshot(await this.take(nibbletId, "manual", label));
    });
  }

  async rename(id: string, label: string | null): Promise<Snapshot> {
    const [row] = await this.d.store.db
      .update(snapshotsTable)
      .set({ label: label?.trim() || null })
      .where(eq(snapshotsTable.id, id))
      .returning();
    if (!row) throw new RpcError("not_found", "That snapshot doesn't exist");
    this.changed(row.nibbletId);
    return toSnapshot(row);
  }

  async delete(id: string): Promise<void> {
    const row = await this.row(id);
    await this.remove(row);
    this.changed(row.nibbletId);
  }

  /**
   * Puts a nibblet back (or forward) to a snapshot: snapshots the present,
   * stops it, swaps its home folder and state, then starts it again if it
   * was running.
   */
  async restore(id: string): Promise<void> {
    const target = await this.row(id);
    const nibbletId = target.nibbletId;
    await this.exclusively(nibbletId, "restoring", async () => {
      const state = SnapshotState.parse(
        JSON.parse(gunzipSync(await readFile(this.file(target, "state"))).toString("utf8")),
      );
      if (this.d.conductor.busy(nibbletId)) this.d.conductor.interrupt(nibbletId);
      await this.waitIdle(nibbletId, 30_000).catch(() => undefined);

      const name = target.label ? `“${target.label}”` : when(target.createdAt);
      await this.take(nibbletId, "before_restore", `Before restoring ${name}`);

      const before = await this.d.store.getNibblet(nibbletId);
      const wasRunning = before.status !== "stopped" && before.status !== "error";
      await this.d.conductor.stop(nibbletId);
      await this.d.store.setStatus(nibbletId, "starting", "Restoring a snapshot…");
      try {
        const old = await this.d.store.listSchedules(nibbletId);
        for (const s of old) this.d.scheduler.disarm(s.id);

        await this.d.homes.restoreHome(nibbletId, createReadStream(this.file(target, "home")));
        await importState(this.d.store.db, nibbletId, state);

        for (const s of await this.d.store.listSchedules(nibbletId))
          await this.d.scheduler.arm(s.id);
        await this.d.store.setSetting(positionKey(nibbletId), {
          snapshotId: target.id,
          maxSeq: await maxSeq(this.d.store.db, nibbletId),
        } satisfies Position);
      } catch (err) {
        await this.d.store.setStatus(
          nibbletId,
          "error",
          `Restoring a snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      } finally {
        this.d.bus.publish({ type: "thread_reset", nibbletId });
        this.d.bus.publish({ type: "schedules_changed", nibbletId });
      }
      if (wasRunning) await this.d.conductor.start(nibbletId);
      else await this.d.store.updateNibblet(nibbletId, { status: "stopped", statusDetail: null });
    });
  }

  /** Takes automatic snapshots that are due, for nibblets that are idle and have changed. */
  async tick(now = new Date()): Promise<void> {
    for (const n of await this.d.store.listNibblets()) {
      const every = n.snapshotPolicy.everyMinutes;
      if (every === null || this.activity.has(n.id) || this.d.conductor.busy(n.id)) continue;
      if (n.status === "starting") continue;
      const rows = await this.rows(n.id);
      const lastAuto = rows.find((r) => r.trigger === "auto");
      if (lastAuto && now.getTime() - lastAuto.createdAt.getTime() < every * 60_000) continue;
      const live = await maxSeq(this.d.store.db, n.id);
      const position = await this.position(n.id);
      const seen = Math.max(rows[0]?.maxSeq ?? 0, position?.maxSeq ?? 0);
      // Nothing has happened since the last snapshot: another would be a copy.
      if (live === 0 || live <= seen) continue;
      await this.exclusively(n.id, "snapshotting", () => this.take(n.id, "auto", null)).catch(
        (err: unknown) => console.error(`automatic snapshot of ${n.id} failed`, err),
      );
    }
  }

  /** Writes both halves, records the row, and trims old ones. */
  private async take(
    nibbletId: string,
    trigger: SnapshotTrigger,
    label: string | null,
  ): Promise<SnapshotRow> {
    const id = newId("snap");
    const dir = join(this.root, nibbletId);
    await mkdir(dir, { recursive: true });
    const draft = { id, nibbletId };
    const statePath = this.file(draft, "state");
    const homePath = this.file(draft, "home");
    try {
      const state = await exportState(this.d.store.db, nibbletId);
      await writeFile(statePath, gzipSync(JSON.stringify(state)));
      const out = createWriteStream(homePath);
      await this.d.homes.archiveHome(nibbletId, out);
      out.end();
      await finished(out);
      const sizeBytes = (await stat(statePath)).size + (await stat(homePath)).size;
      const [row] = await this.d.store.db
        .insert(snapshotsTable)
        .values({
          id,
          nibbletId,
          label: label?.trim() || null,
          trigger,
          sizeBytes,
          messageCount: messageCount(state),
          maxSeq: state.items.reduce((max, r) => Math.max(max, r.seq), 0),
        })
        .returning();
      if (!row) throw new Error("The snapshot wasn't recorded");
      await this.prune(nibbletId);
      return row;
    } catch (err) {
      await rm(statePath, { force: true });
      await rm(homePath, { force: true });
      throw err;
    }
  }

  /** Keeps the newest `keep` automatic snapshots and a few before-restore ones; manual ones stay. */
  private async prune(nibbletId: string): Promise<void> {
    const nibblet = await this.d.store.getNibblet(nibbletId);
    const rows = await this.rows(nibbletId);
    const autos = rows.filter((r) => r.trigger === "auto");
    const befores = rows.filter((r) => r.trigger === "before_restore");
    for (const row of [
      ...autos.slice(nibblet.snapshotPolicy.keep),
      ...befores.slice(KEEP_BEFORE_RESTORE),
    ]) {
      await this.remove(row);
    }
  }

  private async remove(row: SnapshotRow): Promise<void> {
    await this.d.store.db.delete(snapshotsTable).where(eq(snapshotsTable.id, row.id));
    await rm(this.file(row, "state"), { force: true });
    await rm(this.file(row, "home"), { force: true });
  }

  /** A deleted nibblet's rows go with it; this clears its files. */
  private async forget(nibbletId: string): Promise<void> {
    await rm(join(this.root, nibbletId), { recursive: true, force: true });
    await this.d.store.deleteSetting(positionKey(nibbletId));
  }

  private file(row: { id: string; nibbletId: string }, half: "home" | "state"): string {
    return join(
      this.root,
      row.nibbletId,
      half === "home" ? `${row.id}.home.tar.gz` : `${row.id}.state.json.gz`,
    );
  }

  private rows(nibbletId: string): Promise<SnapshotRow[]> {
    return this.d.store.db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.nibbletId, nibbletId))
      .orderBy(desc(snapshotsTable.createdAt), desc(snapshotsTable.id));
  }

  private async row(id: string): Promise<SnapshotRow> {
    const [row] = await this.d.store.db
      .select()
      .from(snapshotsTable)
      .where(eq(snapshotsTable.id, id));
    if (!row) throw new RpcError("not_found", "That snapshot doesn't exist");
    return row;
  }

  private position(nibbletId: string): Promise<Position | null> {
    return this.d.store.getSetting(positionKey(nibbletId), (v) => Position.parse(v), null);
  }

  private async waitIdle(nibbletId: string, timeoutMs = this.d.idleTimeoutMs ?? 10 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.d.conductor.busy(nibbletId)) {
      if (Date.now() > deadline) {
        throw new RpcError("conflict", "It's still busy. Try again when it's finished.");
      }
      await new Promise((r) => setTimeout(r, this.d.pollMs ?? 1000));
    }
  }

  /** One snapshot or restore at a time per nibblet, announced to the UI. */
  private async exclusively<T>(
    nibbletId: string,
    kind: NonNullable<SnapshotActivity>,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.activity.has(nibbletId)) {
      throw new RpcError("conflict", "A snapshot or restore is already under way");
    }
    this.activity.set(nibbletId, kind);
    this.changed(nibbletId);
    try {
      return await work();
    } finally {
      this.activity.delete(nibbletId);
      this.changed(nibbletId);
    }
  }

  private changed(nibbletId: string): void {
    this.d.bus.publish({
      type: "snapshots_changed",
      nibbletId,
      activity: this.activity.get(nibbletId) ?? null,
    });
  }
}
