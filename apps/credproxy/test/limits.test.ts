import { describe, expect, it } from "vitest";
import { anthropicLimit, openaiLimit } from "../src/limits.ts";

const now = Date.parse("2026-10-14T10:00:00Z");

describe("anthropicLimit", () => {
  it("reads the unified reset when a subscription limit is hit", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(now / 1000 + 3600),
    });
    expect(anthropicLimit(429, headers, now)).toBe(now + 3_600_000);
  });

  it("falls back to retry-after for plain rate limits", () => {
    expect(anthropicLimit(429, new Headers({ "retry-after": "30" }), now)).toBe(now + 30_000);
  });

  it("ignores ordinary responses", () => {
    expect(
      anthropicLimit(200, new Headers({ "anthropic-ratelimit-unified-status": "allowed" }), now),
    ).toBeNull();
    expect(anthropicLimit(500, new Headers(), now)).toBeNull();
  });
});

describe("openaiLimit", () => {
  it("reads resets_at from the Codex backend's usage_limit_reached body", () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", resets_at: now / 1000 + 7200, plan_type: "plus" },
    });
    expect(openaiLimit(429, new Headers(), body, now)).toBe(now + 7_200_000);
  });

  it("reads resets_in_seconds when there's no timestamp", () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 90 } });
    expect(openaiLimit(429, new Headers(), body, now)).toBe(now + 90_000);
  });

  it("waits a minute on a 429 it can't read", () => {
    expect(openaiLimit(429, new Headers(), "not json", now)).toBe(now + 60_000);
    expect(openaiLimit(200, new Headers(), null, now)).toBeNull();
  });
});
