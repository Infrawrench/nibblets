import { describe, expect, it } from "vitest";
import type { StoredItem, ThreadItem } from "@nibblet/protocol";
import { buildTimeline, maxSeq, runningTurn, upsertItems } from "./thread.ts";

const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, s)).toISOString();
const stored = (seq: number, item: ThreadItem): StoredItem => ({ nibbletId: "n", seq, item });
const msg = (id: string, s: number, text: string, streaming = false): ThreadItem => ({
  type: "assistant_message",
  id,
  turnId: "t",
  createdAt: at(s),
  text,
  streaming,
});

describe("upsertItems", () => {
  it("keeps the newest copy of each item", () => {
    const merged = upsertItems(
      [stored(1, msg("a", 1, "Hel", true))],
      [stored(3, msg("a", 1, "Hello"))],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.item).toMatchObject({ text: "Hello", streaming: false });
  });

  it("ignores stale updates", () => {
    const merged = upsertItems(
      [stored(5, msg("a", 1, "Hello"))],
      [stored(2, msg("a", 1, "Hel", true))],
    );
    expect(merged[0]?.item).toMatchObject({ text: "Hello" });
  });

  it("orders by creation time, not seq", () => {
    const merged = upsertItems(
      [],
      [stored(9, msg("first", 1, "x")), stored(4, msg("second", 2, "y"))],
    );
    expect(merged.map((s) => s.item.id)).toEqual(["first", "second"]);
    expect(maxSeq(merged)).toBe(9);
  });
});

describe("buildTimeline", () => {
  it("collapses a quiet heartbeat turn to one line", () => {
    const items = upsertItems(
      [],
      [
        stored(1, {
          type: "user_message",
          id: "u",
          turnId: "hb",
          createdAt: at(1),
          text: "Heartbeat",
          source: "heartbeat",
        }),
        stored(2, {
          type: "turn",
          id: "hb",
          turnId: null,
          createdAt: at(1),
          source: "heartbeat",
          status: "completed",
          quiet: true,
          usage: null,
          endedAt: at(2),
        }),
        stored(3, { ...msg("m", 2, "NO_REPLY"), turnId: "hb" }),
      ],
    );
    const timeline = buildTimeline(items);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "quiet", source: "heartbeat" });
  });

  it("shows non-user messages as triggers and hides turn markers", () => {
    const items = upsertItems(
      [],
      [
        stored(1, {
          type: "user_message",
          id: "u",
          turnId: "s",
          createdAt: at(1),
          text: "Do the thing",
          source: "schedule",
        }),
        stored(2, {
          type: "turn",
          id: "s",
          turnId: null,
          createdAt: at(1),
          source: "schedule",
          status: "running",
          quiet: false,
          usage: null,
          endedAt: null,
        }),
        stored(3, { ...msg("m", 2, "Doing it", true), turnId: "s" }),
      ],
    );
    expect(buildTimeline(items).map((e) => e.kind)).toEqual(["trigger", "item"]);
    expect(runningTurn(items)?.id).toBe("s");
  });
});
