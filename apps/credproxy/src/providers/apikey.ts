import type { CredentialStatus } from "@nibblet/protocol";

/**
 * A provider on an API key rather than a subscription login: nothing to
 * refresh and no usage limit to note, so it skips the token manager.
 */
export interface ApiKeyProvider {
  readonly id: CredentialStatus["provider"];
  readonly key: string | null;
  /** The upstream URL for a path under this provider's proxy prefix. */
  upstream(path: string, search: string): string;
  /** Sets auth on an outgoing request's headers. */
  authorise(headers: Headers, apiKey: string): void;
  status(): CredentialStatus;
}

export function apiKeyProvider(opts: {
  id: CredentialStatus["provider"];
  key: string | null;
  upstreamBase: string;
  /** The variable that holds the key, for the status page when it's missing. */
  envName: string;
  authorise(headers: Headers, apiKey: string): void;
}): ApiKeyProvider {
  const { id, key, upstreamBase, envName, authorise } = opts;
  return {
    id,
    key,
    upstream: (path, search) => `${upstreamBase}${path}${search}`,
    authorise,
    status: () => ({
      provider: id,
      source: key ? "env" : "none",
      ok: key !== null,
      detail: key ? "API key set" : `${envName} isn't set`,
      plan: null,
      expiresAt: null,
      limitedUntil: null,
    }),
  };
}

/** Auth for Anthropic's Messages API, and the APIs that copy it (DeepSeek's). */
export function anthropicStyleAuthorise(headers: Headers, apiKey: string): void {
  headers.delete("authorization");
  headers.set("x-api-key", apiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
}

/** Anthropic's API on a Console API key, instead of a Claude subscription. */
export function anthropicKeyProvider(
  key: string | null,
  upstreamBase = "https://api.anthropic.com",
) {
  return apiKeyProvider({
    id: "anthropic",
    key,
    upstreamBase,
    envName: "NIBBLET_ANTHROPIC_API_KEY",
    authorise: anthropicStyleAuthorise,
  });
}

/**
 * OpenAI's API on a platform API key, instead of a ChatGPT subscription.
 * Codex still thinks it's signed in to ChatGPT (the placeholder login), and
 * sends the same Responses requests either way; only where they go changes.
 */
export function openaiKeyProvider(key: string | null, upstreamBase = "https://api.openai.com/v1") {
  return apiKeyProvider({
    id: "openai",
    key,
    upstreamBase,
    envName: "NIBBLET_OPENAI_API_KEY",
    authorise(headers, apiKey) {
      headers.delete("x-api-key");
      headers.delete("chatgpt-account-id");
      headers.set("authorization", `Bearer ${apiKey}`);
    },
  });
}
