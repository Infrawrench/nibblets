import { z } from "zod";
import { CredentialStatus } from "./schema.ts";

/**
 * Monthly budgets for nibblets on API keys. The credential proxy reads the
 * token usage off every response it relays on an API key and reports it to
 * the server, which prices it here and adds it to the nibblet's month. Before
 * relaying a request, the proxy asks whether the nibblet still has budget.
 *
 * A subscription costs the same however much it's used, so only API keys
 * (Claude and ChatGPT when set up with one, and DeepSeek) count.
 */

export const BilledProvider = CredentialStatus.shape.provider;
export type BilledProvider = z.infer<typeof BilledProvider>;

/** One response's usage, as the proxy reads it off the provider's own report. */
export const ApiUsage = z.object({
  /** Input that was neither read from nor written to the cache. */
  inputTokens: z.int().min(0),
  cachedInputTokens: z.int().min(0),
  /** Written to the cache for the default lifetime (Anthropic's five minutes). */
  cacheWriteTokens: z.int().min(0),
  /** Written to Anthropic's one-hour cache. */
  cacheWrite1hTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  /** Server-side web searches, which are priced per search. */
  webSearches: z.int().min(0),
});
export type ApiUsage = z.infer<typeof ApiUsage>;

export const emptyUsage: ApiUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  webSearches: 0,
};

/** What the proxy reports to the server after relaying a request on an API key. */
export const MeteredRequest = z.object({
  /** Whose budget it counts against: a sub-agent's requests count against its host's. */
  nibbletId: z.string(),
  provider: BilledProvider,
  model: z.string(),
  usage: ApiUsage,
});
export type MeteredRequest = z.infer<typeof MeteredRequest>;

/** A nibblet's budget and what it has spent this month. */
export const BudgetStatus = z.object({
  /** The nibblet whose budget this is: for a sub-agent, its host's. */
  nibbletId: z.string(),
  /** Null for no limit. */
  budgetUsd: z.number().nullable(),
  spentUsd: z.number(),
  /** The calendar month (UTC) it's for, like `2026-10`. */
  month: z.string(),
  resetsAt: z.iso.datetime(),
  /** False once what it has spent reaches its budget. */
  allowed: z.boolean(),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/** The calendar month, in UTC, that spending on `date` counts towards. */
export function budgetMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** When the month `date` is in ends, and budgets start again. */
export function budgetResetsAt(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

/** US dollars per million tokens. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** A prompt longer than `above` tokens costs more for the whole request. */
  longContext?: { above: number; inputFactor: number; outputFactor: number };
}

const OPENAI_LONG = { above: 272_000, inputFactor: 2, outputFactor: 1.5 };

/**
 * List prices, October 2026. Where a price is temporary or varies by the
 * hour, this is the higher one, so a budget runs out early rather than late:
 * GPT-5.6 Sol is at its list price rather than its promotion, and DeepSeek
 * at its weekday peak rather than off-peak.
 */
export const apiPrices: Record<BilledProvider, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-fable-5-1": {
      input: 10,
      cachedInput: 0.25,
      cacheWrite: 12.5,
      cacheWrite1h: 20,
      output: 50,
    },
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20 },
    "claude-sonnet-5-5": {
      input: 2,
      cachedInput: 0.1,
      cacheWrite: 2.5,
      cacheWrite1h: 4,
      output: 10,
    },
    "claude-haiku-5-5": {
      input: 0.1,
      cachedInput: 0.01,
      cacheWrite: 0.125,
      cacheWrite1h: 0.2,
      output: 0.5,
      longContext: { above: 100_000, inputFactor: 5, outputFactor: 5 },
    },
  },
  openai: {
    "gpt-6.1-sol": {
      input: 2,
      cachedInput: 0.1,
      cacheWrite: 2.5,
      cacheWrite1h: 2.5,
      output: 10,
      longContext: OPENAI_LONG,
    },
    "gpt-6-astra": {
      input: 10,
      cachedInput: 1,
      cacheWrite: 12.5,
      cacheWrite1h: 12.5,
      output: 50,
      longContext: OPENAI_LONG,
    },
    "gpt-6-sol": {
      input: 2,
      cachedInput: 0.2,
      cacheWrite: 2.5,
      cacheWrite1h: 2.5,
      output: 10,
      longContext: OPENAI_LONG,
    },
    "gpt-6-luna": {
      input: 0.1,
      cachedInput: 0.01,
      cacheWrite: 0.125,
      cacheWrite1h: 0.125,
      output: 0.5,
      longContext: OPENAI_LONG,
    },
    "gpt-5.6-sol": {
      input: 5,
      cachedInput: 0.5,
      cacheWrite: 6.25,
      cacheWrite1h: 6.25,
      output: 30,
      longContext: OPENAI_LONG,
    },
    "gpt-5.6-terra": {
      input: 2,
      cachedInput: 0.2,
      cacheWrite: 2.5,
      cacheWrite1h: 2.5,
      output: 12,
      longContext: OPENAI_LONG,
    },
    "gpt-5.6-luna": {
      input: 0.2,
      cachedInput: 0.02,
      cacheWrite: 0.25,
      cacheWrite1h: 0.25,
      output: 1.2,
      longContext: OPENAI_LONG,
    },
  },
  // DeepSeek doesn't charge for writing to its cache.
  deepseek: {
    "deepseek-flash": {
      input: 0.3,
      cachedInput: 0.006,
      cacheWrite: 0.3,
      cacheWrite1h: 0.3,
      output: 1.2,
    },
    "deepseek-v4-flash": {
      input: 0.3,
      cachedInput: 0.006,
      cacheWrite: 0.3,
      cacheWrite1h: 0.3,
      output: 1.2,
    },
    "deepseek-v4-pro": {
      input: 1.32,
      cachedInput: 0.044,
      cacheWrite: 1.32,
      cacheWrite1h: 1.32,
      output: 3.96,
    },
  },
};

/** Per search, on both Anthropic's and OpenAI's web search tools. */
const WEB_SEARCH_USD = 0.01;

/**
 * A model's price. Providers report dated ids (`claude-haiku-5-5-20261001`),
 * so the longest listed id the model starts with wins. A model that isn't
 * listed is charged as the provider's dearest, so it can't slip past a budget.
 */
export function priceOf(provider: BilledProvider, model: string): ModelPrice {
  const listed = Object.entries(apiPrices[provider]);
  const match = listed
    .filter(([id]) => model.startsWith(id))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (match) return match[1];
  return listed.map(([, p]) => p).reduce((a, b) => (b.output > a.output ? b : a));
}

/** What one response cost, in US dollars. */
export function apiCostUsd(provider: BilledProvider, model: string, usage: ApiUsage): number {
  const price = priceOf(provider, model);
  // OpenAI writes uncached input to its cache by default and charges the
  // write rate for it, but its usage doesn't say how much it wrote, so all of
  // it is charged at that rate, which errs high.
  const uncached = provider === "openai" ? price.cacheWrite : price.input;
  const prompt =
    usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.cacheWrite1hTokens;
  const long = price.longContext && prompt > price.longContext.above ? price.longContext : null;
  const inputSide =
    usage.inputTokens * uncached +
    usage.cachedInputTokens * price.cachedInput +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.cacheWrite1hTokens * price.cacheWrite1h;
  const tokens =
    inputSide * (long?.inputFactor ?? 1) +
    usage.outputTokens * price.output * (long?.outputFactor ?? 1);
  return tokens / 1_000_000 + usage.webSearches * WEB_SEARCH_USD;
}
