import { anthropicStyleAuthorise, apiKeyProvider } from "./apikey.ts";

export const DEEPSEEK_UPSTREAM = "https://api.deepseek.com/anthropic";

/** DeepSeek's Anthropic-compatible API, which only takes an API key. */
export function deepseekProvider(key: string | null, upstreamBase = DEEPSEEK_UPSTREAM) {
  return apiKeyProvider({
    id: "deepseek",
    key,
    upstreamBase,
    envName: "DEEPSEEK_API_KEY",
    authorise: anthropicStyleAuthorise,
  });
}

export type DeepseekProvider = ReturnType<typeof deepseekProvider>;
