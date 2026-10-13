import type { ActiveHours, Schedule } from "@nibblet/protocol";
import { Cron } from "croner";
import type { Conductor } from "./conductor.ts";
import { scheduleInput } from "./context.ts";
import type { Store } from "./store.ts";

const HEARTBEAT_TICK_MS = 30_000;

/** Whether `at` falls inside the active hours, which may wrap past midnight. */
export function withinActiveHours(hours: ActiveHours | null, at: Date): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const current = `${hh}:${mm}`;
  return hours.start <= hours.end
    ? current >= hours.start && current < hours.end
    : current >= hours.start || current < hours.end;
}

/**
 * Wakes nibblets: one croner job per enabled schedule, plus a ticker that
 * fires each nibblet's heartbeat when it's due and it isn't already busy.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Cron>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly store: Store;
  private readonly conductor: Conductor;

  constructor(store: Store, conductor: Conductor) {
    this.store = store;
    this.conductor = conductor;
  }

  async start(): Promise<void> {
    for (const row of await this.store.listSchedules()) this.arm(row.id);
    this.ticker = setInterval(() => void this.tickHeartbeats(), HEARTBEAT_TICK_MS);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** (Re)creates the job for a schedule after it was added or changed. */
  async arm(id: string): Promise<void> {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    const row = await this.store.scheduleRow(id).catch(() => null);
    if (!row?.enabled) return;
    if (!row.cron && row.runAt && row.runAt.getTime() < Date.now()) return;
    const pattern = row.cron ?? row.runAt;
    if (!pattern) return;
    const job = new Cron(
      pattern,
      { timezone: row.timezone, protect: true },
      () => void this.fire(id),
    );
    this.jobs.set(id, job);
  }

  disarm(id: string): void {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  nextRun(id: string): Date | null {
    return this.jobs.get(id)?.nextRun() ?? null;
  }

  async describe(nibbletId: string): Promise<Schedule[]> {
    const rows = await this.store.listSchedules(nibbletId);
    return rows.map((r) => this.store.toSchedule(r, this.nextRun(r.id)));
  }

  private async fire(id: string): Promise<void> {
    const row = await this.store.scheduleRow(id).catch(() => null);
    if (!row?.enabled) return;
    const patch = row.cron ? { lastRunAt: new Date() } : { lastRunAt: new Date(), enabled: false };
    await this.store.updateSchedule(id, patch);
    if (!row.cron) this.disarm(id);
    await this.conductor
      .enqueue(row.nibbletId, "schedule", scheduleInput(row.name, row.prompt))
      .catch((err: unknown) => console.error(`schedule ${id} failed`, err));
  }

  private async tickHeartbeats(): Promise<void> {
    const now = new Date();
    const rows = await this.store.db.query.nibblets.findMany();
    for (const row of rows) {
      const hb = row.heartbeat;
      if (!hb.enabled || row.status === "error") continue;
      if (this.conductor.busy(row.id)) continue;
      const last = row.lastHeartbeatAt ?? row.createdAt;
      if (now.getTime() - last.getTime() < hb.everyMinutes * 60_000) continue;
      if (!withinActiveHours(hb.activeHours, now)) continue;
      await this.conductor
        .heartbeat(row.id)
        .catch((err: unknown) => console.error(`heartbeat ${row.id} failed`, err));
    }
  }
}
