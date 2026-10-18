import type { CredentialStatus } from "@nibblet/protocol";

export const DEEPSEEK_UPSTREAM = "https://api.deepseek.com/anthropic";

/**
 * DeepSeek's Anthropic-compatible API, on an API key rather than a
 * subscription login: nothing to refresh, so it skips the token manager.
 */
export function deepseekProvider(key: string | null, upstreamBase = DEEPSEEK_UPSTREAM) {
  return {
    id: "deepseek" as const,
    key,
    upstream(path: string, search: string): string {
      return `${upstreamBase}${path}${search}`;
    },
    authorise(headers: Headers, apiKey: string): void {
      headers.delete("authorization");
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    },
    status(): CredentialStatus {
      return {
        provider: "deepseek",
        source: key ? "env" : "none",
        ok: key !== null,
        detail: key ? "API key set" : "DEEPSEEK_API_KEY isn't set",
        plan: null,
        expiresAt: null,
        limitedUntil: null,
      };
    },
  };
}

export type DeepseekProvider = ReturnType<typeof deepseekProvider>;
