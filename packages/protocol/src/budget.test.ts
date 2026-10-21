import { describe, expect, it } from "vitest";
import { apiCostUsd, budgetMonth, budgetResetsAt, emptyUsage, priceOf } from "./budget.ts";

const million = 1_000_000;

describe("apiCostUsd", () => {
  it("prices each kind of token at its own rate", () => {
    const usage = {
      ...emptyUsage,
      inputTokens: million,
      cachedInputTokens: million,
      cacheWriteTokens: million,
      cacheWrite1hTokens: million,
      outputTokens: million,
      webSearches: 3,
    };
    // Opus 5.5: 4 + 0.2 + 5 + 8 + 20, and three searches at a cent each.
    expect(apiCostUsd("anthropic", "claude-opus-5-5", usage)).toBeCloseTo(37.23);
  });

  it("charges OpenAI's uncached input at its cache-write rate", () => {
    const usage = { ...emptyUsage, inputTokens: 100_000, cachedInputTokens: 100_000 };
    expect(apiCostUsd("openai", "gpt-6-sol", usage)).toBeCloseTo(0.25 + 0.02);
    // Past 272K of prompt, input costs double.
    const long = { ...emptyUsage, inputTokens: 300_000 };
    expect(apiCostUsd("openai", "gpt-6-sol", long)).toBeCloseTo(0.75 * 2);
  });

  it("charges a long prompt the long-context rate for the whole request", () => {
    const short = { ...emptyUsage, inputTokens: 100_000, outputTokens: 1000 };
    const long = { ...emptyUsage, inputTokens: 100_001, outputTokens: 1000 };
    expect(apiCostUsd("anthropic", "claude-haiku-5-5", short)).toBeCloseTo(0.0105);
    expect(apiCostUsd("anthropic", "claude-haiku-5-5", long)).toBeCloseTo(0.0525, 4);
  });

  it("matches dated model ids, and charges unknown ones as the dearest", () => {
    expect(priceOf("anthropic", "claude-haiku-5-5-20261001").output).toBe(0.5);
    expect(priceOf("openai", "gpt-6.1-sol").output).toBe(10);
    expect(priceOf("openai", "gpt-7-nova").output).toBe(50);
    expect(priceOf("deepseek", "").output).toBe(3.96);
  });
});

describe("budget months", () => {
  it("run by calendar month in UTC", () => {
    const late = new Date("2026-12-31T23:30:00Z");
    expect(budgetMonth(late)).toBe("2026-12");
    expect(budgetResetsAt(late).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
