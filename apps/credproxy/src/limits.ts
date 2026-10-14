import { z } from "zod";

/**
 * When a subscription's usage limit resets, read off an upstream response.
 * Null means the response says nothing about a limit being hit.
 *
 * Anthropic (Claude subscriptions over OAuth) marks a refused request with
 * `anthropic-ratelimit-unified-status: rejected` and puts the reset, in epoch
 * seconds, in `anthropic-ratelimit-unified-reset`; plain API rate limits only
 * have `retry-after`. The ChatGPT Codex backend answers 429 with a JSON body
 * whose `error.type` is `usage_limit_reached` (or `usage_not_included`) and
 * gives `resets_at` (epoch seconds) or `resets_in_seconds`.
 */
export function anthropicLimit(status: number, headers: Headers, now: number): number | null {
  const unified = headers.get("anthropic-ratelimit-unified-status");
  if (status !== 429 && unified !== "rejected") return null;
  const reset = Number(headers.get("anthropic-ratelimit-unified-reset"));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return retryAfter(headers, now);
}

const CodexLimitBody = z.object({
  error: z.looseObject({
    type: z.string().optional(),
    code: z.string().optional(),
    resets_at: z.number().optional(),
    resets_in_seconds: z.number().optional(),
  }),
});

const CODEX_LIMIT_TYPES = new Set([
  "usage_limit_reached",
  "usage_not_included",
  "rate_limit_exceeded",
]);

export function openaiLimit(
  status: number,
  headers: Headers,
  body: string | null,
  now: number,
): number | null {
  if (status !== 429) return null;
  let parsed: z.infer<typeof CodexLimitBody> | null = null;
  try {
    const result = CodexLimitBody.safeParse(JSON.parse(body ?? "null"));
    parsed = result.success ? result.data : null;
  } catch {
    parsed = null;
  }
  const kind = parsed?.error.type ?? parsed?.error.code;
  if (parsed && kind && CODEX_LIMIT_TYPES.has(kind)) {
    if (parsed.error.resets_at) return parsed.error.resets_at * 1000;
    if (parsed.error.resets_in_seconds) return now + parsed.error.resets_in_seconds * 1000;
  }
  return retryAfter(headers, now);
}

/** `retry-after` as seconds or an HTTP date; a 429 with neither waits a minute. */
function retryAfter(headers: Headers, now: number): number {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return now + seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return now + 60_000;
}
