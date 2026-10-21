import {
  placeLabel,
  RpcError,
  type LocationFix,
  type NibbletLocation,
  type ThreadItemOf,
} from "@nibblet/protocol";
import type { Geocoder } from "./geocode.ts";
import { newId } from "./store.ts";

/** The store calls location requests need, so tests can stand in for the database. */
export interface LocationStore {
  putItem(nibbletId: string, item: ThreadItemOf<"location_request">): Promise<unknown>;
  updateNibblet(id: string, patch: { location: NibbletLocation | null }): Promise<unknown>;
  nibbletRow(id: string): Promise<{ parentId: string | null; location: NibbletLocation | null }>;
  pendingLocationRequests(): Promise<
    { nibbletId: string; item: ThreadItemOf<"location_request"> }[]
  >;
}

/** A position from a device, with the place it's in, as it's kept. */
export async function toLocation(
  geocoder: Pick<Geocoder, "place">,
  fix: LocationFix,
  now = new Date(),
): Promise<NibbletLocation> {
  return {
    ...fix,
    place: await geocoder.place(fix.latitude, fix.longitude),
    sharedAt: now.toISOString(),
  };
}

/**
 * How asking went: `nobody` when no Nibblets was open to ask, `unanswered`
 * when one was but nothing came back in time.
 */
export type LocationAnswer =
  | { kind: "shared"; location: NibbletLocation }
  | { kind: "declined" }
  | { kind: "unanswered" }
  | { kind: "nobody" };

interface Pending {
  nibbletId: string;
  item: ThreadItemOf<"location_request">;
  answer: Promise<LocationAnswer>;
  resolve: (answer: LocationAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Its first write, "pending": what it comes to is written after, never under it. */
  written: Promise<unknown>;
}

/** How long `location_get` waits for a device: inside the tool-call timeouts harnesses set. */
export const LOCATION_WAIT_MS = 45_000;

/**
 * `location_get` asking the person's device where they are now. Each ask is
 * a `location_request` item in the thread, which every open UI sees: one
 * the person has let answer by itself does, and the others ask them. The
 * first answer wins; what's shared is kept as the nibblet's location.
 */
export class LocationRequests {
  private readonly pending = new Map<string, Pending>();
  private readonly store: LocationStore;
  private readonly geocoder: Pick<Geocoder, "place">;
  private readonly viewers: () => number;
  private readonly timeoutMs: number;

  constructor(opts: {
    store: LocationStore;
    geocoder: Pick<Geocoder, "place">;
    /** How many UIs are open, any of which might answer. */
    viewers: () => number;
    timeoutMs?: number;
  }) {
    this.store = opts.store;
    this.geocoder = opts.geocoder;
    this.viewers = opts.viewers;
    this.timeoutMs = opts.timeoutMs ?? LOCATION_WAIT_MS;
  }

  /** After a restart nothing waits on old asks: close them. */
  async resetStale(): Promise<void> {
    for (const { nibbletId, item } of await this.store.pendingLocationRequests()) {
      await this.store.putItem(nibbletId, {
        ...item,
        status: "unanswered",
        decidedAt: new Date().toISOString(),
      });
    }
  }

  ask(nibbletId: string, turnId: string | null): Promise<LocationAnswer> {
    if (this.viewers() === 0) return Promise.resolve({ kind: "nobody" });
    // A second ask while one waits gets the same answer, rather than asking twice.
    for (const p of this.pending.values()) if (p.nibbletId === nibbletId) return p.answer;
    const item: ThreadItemOf<"location_request"> = {
      type: "location_request",
      id: newId("loc"),
      turnId,
      createdAt: new Date().toISOString(),
      status: "pending",
      place: null,
      decidedAt: null,
    };
    let resolve: (answer: LocationAnswer) => void = () => undefined;
    const answer = new Promise<LocationAnswer>((r) => (resolve = r));
    const timer = setTimeout(() => {
      const entry = this.pending.get(item.id);
      if (entry) void this.finish(entry, { kind: "unanswered" });
    }, this.timeoutMs);
    const written = this.store.putItem(nibbletId, item);
    this.pending.set(item.id, { nibbletId, item, answer, resolve, timer, written });
    return written.then(
      () => answer,
      (err: unknown) => {
        this.drop(item.id);
        throw err;
      },
    );
  }

  /** A device's answer: where it is, or null when the person said no. */
  async answer(nibbletId: string, requestId: string, fix: LocationFix | null): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.nibbletId !== nibbletId)
      throw new RpcError("not_found", "It isn't waiting to hear where you are any more");
    // Taken now, so a second device answering meanwhile is turned away.
    this.drop(requestId);
    if (!fix) {
      await this.finish(entry, { kind: "declined" });
      return;
    }
    try {
      const location = await toLocation(this.geocoder, fix);
      await this.store.updateNibblet(await this.holder(nibbletId), { location });
      await this.finish(entry, { kind: "shared", location });
    } catch (err) {
      await this.finish(entry, { kind: "unanswered" });
      throw err;
    }
  }

  /** Gives up on whatever a nibblet is asking, when its turn or container stops. */
  async cancelAll(nibbletId: string): Promise<void> {
    for (const entry of [...this.pending.values()]) {
      if (entry.nibbletId !== nibbletId) continue;
      this.drop(entry.item.id);
      await this.finish(entry, { kind: "unanswered" });
    }
  }

  /**
   * Whose location a fresh answer updates: its own when it has one, or the
   * top of its tree's, which its sub-agents go by.
   */
  private async holder(nibbletId: string): Promise<string> {
    let id = nibbletId;
    let row = await this.store.nibbletRow(id);
    if (row.location) return id;
    while (row.parentId) {
      id = row.parentId;
      row = await this.store.nibbletRow(id);
    }
    return id;
  }

  private drop(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
  }

  /** Records what an ask came to, then answers it: whoever asked then reads it as it is. */
  private async finish(entry: Pending, answer: LocationAnswer): Promise<void> {
    this.drop(entry.item.id);
    await entry.written.catch(() => undefined);
    const status =
      answer.kind === "shared" ? "shared" : answer.kind === "declined" ? "declined" : "unanswered";
    await this.store
      .putItem(entry.nibbletId, {
        ...entry.item,
        status,
        place:
          answer.kind === "shared" && answer.location.place
            ? placeLabel(answer.location.place)
            : null,
        decidedAt: new Date().toISOString(),
      })
      .catch((err: unknown) => console.error("couldn't record a location answer", err));
    entry.resolve(answer);
  }
}
