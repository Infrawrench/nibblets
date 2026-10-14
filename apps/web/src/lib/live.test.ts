import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { StoredItem } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { applyLive, keys } from "./servers.tsx";

const stored = (seq: number, text: string): StoredItem => ({
  nibbletId: "pip",
  seq,
  item: {
    type: "user_message",
    id: text,
    turnId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    text,
    source: "user",
  },
});

describe("applyLive", () => {
  it("drops a reset thread and fetches it again from the start", async () => {
    const qc = new QueryClient();
    let server = [stored(1, "one"), stored(2, "two")];
    const asked: number[] = [];
    const observer = new QueryObserver(qc, {
      queryKey: keys.thread("s", "pip"),
      queryFn: async () => {
        asked.push(0);
        return server;
      },
      staleTime: Infinity,
    });
    const off = observer.subscribe(() => undefined);
    await qc.fetchQuery({ queryKey: keys.thread("s", "pip") });

    // After a restore the thread is shorter, with new seqs.
    server = [stored(7, "one")];
    applyLive(qc, "s", { type: "thread_reset", nibbletId: "pip" });
    await new Promise((r) => setTimeout(r, 10));
    expect(qc.getQueryData(keys.thread("s", "pip"))).toEqual([stored(7, "one")]);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    off();
  });

  it("refreshes the snapshot list when it changes", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.snapshots("s", "pip"), { snapshots: [] });
    applyLive(qc, "s", { type: "snapshots_changed", nibbletId: "pip", activity: "restoring" });
    expect(qc.getQueryState(keys.snapshots("s", "pip"))?.isInvalidated).toBe(true);
  });
});
