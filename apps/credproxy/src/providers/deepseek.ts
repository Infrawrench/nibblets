import { apiKeyProvider } from "./apikey.ts";

export const DEEPSEEK_UPSTREAM = "https://api.deepseek.com/anthropic";

/** DeepSeek's Anthropic-compatible API, which only takes an API key. */
export function deepseekProvider(key: string | null, upstreamBase = DEEPSEEK_UPSTREAM) {
  return apiKeyProvider({
    id: "deepseek",
    key,
    upstreamBase,
    envName: "DEEPSEEK_API_KEY",
    authorise(headers, apiKey) {
      headers.delete("authorization");
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    },
  });
}

export type DeepseekProvider = ReturnType<typeof deepseekProvider>;
