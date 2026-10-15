import type { StoredItem, ThreadItem, ThreadItemOf, TurnSource } from "@nibblet/protocol";

/**
 * Merges incoming items into a thread. Items are upserted whole, so the
 * newest copy of an id (highest seq) wins. The result is in display order:
 * by creation time, since an item's seq moves forward every time it
 * updates and would otherwise drag a streaming message below the tool
 * calls that started after it.
 */
export function upsertItems(
  existing: readonly StoredItem[],
  incoming: readonly StoredItem[],
): StoredItem[] {
  const byId = new Map<string, StoredItem>();
  for (const s of existing) byId.set(s.item.id, s);
  let changed = false;
  for (const s of incoming) {
    const current = byId.get(s.item.id);
    if (!current || current.seq < s.seq) {
      byId.set(s.item.id, s);
      changed = true;
    }
  }
  if (!changed && existing.length === byId.size) return [...existing];
  return [...byId.values()].sort(compareItems);
}

function compareItems(a: StoredItem, b: StoredItem): number {
  const t = a.item.createdAt.localeCompare(b.item.createdAt);
  return t !== 0 ? t : a.item.id.localeCompare(b.item.id);
}

/** The cursor to resume a thread from: the highest seq seen. */
export function maxSeq(items: readonly StoredItem[]): number {
  let max = 0;
  for (const s of items) if (s.seq > max) max = s.seq;
  return max;
}

/** The nibblet keeping its status line current: stored, never drawn in the chat. */
export function isStatusCall(item: ThreadItem): boolean {
  return (
    item.type === "tool_call" &&
    item.server === "nibblet" &&
    (item.name === "status_set" || item.name === "status_clear")
  );
}

/** Sharing a file: the file card that follows is what the user sees, not the call. */
export function isShareCall(item: ThreadItem): boolean {
  return item.type === "tool_call" && item.server === "files" && item.name === "share_file";
}

export type TimelineEntry =
  | { kind: "item"; key: string; item: ThreadItem }
  | { kind: "quiet"; key: string; source: TurnSource; at: string; entries: TimelineEntry[] }
  | { kind: "trigger"; key: string; item: ThreadItemOf<"user_message"> };

/**
 * What the thread view draws. Quiet turns (heartbeats, schedules, sub-agent results) collapse
 * to one faint line, holding what the turn did so it can be expanded; turn
 * markers themselves aren't drawn; a message the nibblet got from its
 * heartbeat, a schedule or a sub-agent is a trigger line rather than a chat
 * bubble.
 */
export function buildTimeline(items: readonly StoredItem[]): TimelineEntry[] {
  const quietTurns = new Map<string, ThreadItemOf<"turn">>();
  for (const { item } of items) {
    if (item.type === "turn" && item.quiet && item.status !== "running")
      quietTurns.set(item.id, item);
  }
  const out: TimelineEntry[] = [];
  const quietEntries = new Map<string, TimelineEntry[]>();
  const quietEntry = (turn: ThreadItemOf<"turn">): TimelineEntry[] => {
    let entries = quietEntries.get(turn.id);
    if (!entries) {
      entries = [];
      quietEntries.set(turn.id, entries);
      out.push({
        kind: "quiet",
        key: `quiet-${turn.id}`,
        source: turn.source,
        at: turn.createdAt,
        entries,
      });
    }
    return entries;
  };
  for (const { item } of items) {
    if (isStatusCall(item) || isShareCall(item)) continue;
    if (item.type === "turn") {
      const quiet = quietTurns.get(item.id);
      if (quiet) quietEntry(quiet);
      continue;
    }
    const quiet = item.turnId ? quietTurns.get(item.turnId) : undefined;
    const target = quiet ? quietEntry(quiet) : out;
    if (item.type === "user_message" && item.source !== "user") {
      target.push({ kind: "trigger", key: item.id, item });
      continue;
    }
    target.push({ kind: "item", key: item.id, item });
  }
  return out;
}

/** The running turn, if any, so the composer can offer Stop. */
export function runningTurn(items: readonly StoredItem[]): ThreadItemOf<"turn"> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]?.item;
    if (item?.type === "turn" && item.status === "running") return item;
  }
  return null;
}

export const sourceLabels: Record<TurnSource, string> = {
  user: "You",
  heartbeat: "Heartbeat",
  schedule: "Schedule",
  subagent: "Sub-agent",
  system: "System",
};
