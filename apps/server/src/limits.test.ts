import type { ThreadItem } from "@nibblet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitWaits, looksLikeUsageLimit, providerFor, resumeAt } from "./limits.ts";

describe("providerFor", () => {
  it("knows whose subscription each harness spends", () => {
    expect(providerFor({ harness: "claude", model: "claude-opus-5-5" })).toBe("anthropic");
    expect(providerFor({ harness: "codex", model: "gpt-5.6-terra" })).toBe("openai");
    expect(providerFor({ harness: "opencode", model: "anthropic/claude-haiku-5-5" })).toBe(
      "anthropic",
    );
    expect(providerFor({ harness: "opencode", model: "neon/claude-opus-5-5" })).toBeNull();
  });
});

describe("looksLikeUsageLimit", () => {
  it("spots limit errors and ignores others", () => {
    expect(looksLikeUsageLimit("Claude AI usage limit reached|1760450400")).toBe(true);
    expect(looksLikeUsageLimit("You've hit your usage limit. Try again at 3pm")).toBe(true);
    expect(looksLikeUsageLimit("API Error: 429 Too Many Requests")).toBe(true);
    expect(looksLikeUsageLimit("ENOENT: no such file")).toBe(false);
    expect(looksLikeUsageLimit(null)).toBe(false);
  });
});

describe("resumeAt", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  it("resumes just after a known reset, or after a fixed wait", () => {
    expect(resumeAt(new Date("2026-10-14T12:00:00Z"), now).toISOString()).toBe(
      "2026-10-14T12:00:30.000Z",
    );
    expect(resumeAt(null, now).toISOString()).toBe("2026-10-14T10:15:00.000Z");
  });
});

/** Just enough of Store for LimitWaits, keeping what it writes. */
function fakeStore() {
  const settings = new Map<string, unknown>();
  const items = new Map<string, ThreadItem>();
  const statuses: { status: string; detail: string | null }[] = [];
  return {
    settings,
    items,
    statuses,
    async getSetting<T>(key: string, parse: (v: unknown) => T, fallback: T): Promise<T> {
      return settings.has(key) ? parse(settings.get(key)) : fallback;
    },
    async setSetting(key: string, value: unknown): Promise<void> {
      settings.set(key, JSON.parse(JSON.stringify(value)));
    },
    async getItem(_nibbletId: string, itemId: string): Promise<ThreadItem | null> {
      return items.get(itemId) ?? null;
    },
    async putItem(nibbletId: string, item: ThreadItem) {
      items.set(item.id, item);
      return { nibbletId, seq: items.size, item };
    },
    async setStatus(_id: string, status: "waiting" | "idle", detail: string | null = null) {
      statuses.push({ status, detail });
    },
  };
}

describe("LimitWaits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const turn = { turnId: "turn_1", source: "user" as const, input: "hello" };

  it("holds the work, then resumes it when the limit resets", async () => {
    const store = fakeStore();
    const resumed: string[] = [];
    const waits = new LimitWaits(store, {
      restoreQueue: () => {},
      resume: (id) => resumed.push(id),
    });
    await waits.start("nib_1", "anthropic", new Date("2026-10-14T11:00:00Z"), [turn]);
    expect(waits.waiting("nib_1")).toBe(true);
    expect(store.statuses.at(-1)?.status).toBe("waiting");
    expect([...store.items.values()][0]).toMatchObject({ type: "limit_wait", status: "waiting" });

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(resumed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(resumed).toEqual(["nib_1"]);
    expect(waits.waiting("nib_1")).toBe(false);
    expect([...store.items.values()][0]).toMatchObject({ status: "resumed" });
  });

  it("survives a restart: the queue comes back and the timer is re-armed", async () => {
    const store = fakeStore();
    const first = new LimitWaits(store, { restoreQueue: () => {}, resume: () => {} });
    await first.start("nib_1", "openai", new Date("2026-10-14T10:30:00Z"), [turn]);
    first.stopAll();

    const restored: string[] = [];
    const resumed: string[] = [];
    const second = new LimitWaits(store, {
      restoreQueue: (id, turns) => restored.push(`${id}:${turns.map((t) => t.input).join()}`),
      resume: (id) => resumed.push(id),
    });
    await second.restore();
    expect(restored).toEqual(["nib_1:hello"]);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(resumed).toEqual(["nib_1"]);
  });

  it("'Try now' resumes straight away; a stop cancels without resuming", async () => {
    const store = fakeStore();
    const resumed: string[] = [];
    const waits = new LimitWaits(store, {
      restoreQueue: () => {},
      resume: (id) => resumed.push(id),
    });
    await waits.start("a", null, new Date("2026-10-14T12:00:00Z"), [turn]);
    await waits.start("b", null, new Date("2026-10-14T12:00:00Z"), [turn]);
    await waits.end("a", "resumed");
    await waits.end("b", "cancelled");
    expect(resumed).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(resumed).toEqual(["a"]);
  });
});
