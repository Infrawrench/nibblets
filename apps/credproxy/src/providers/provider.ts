/** The parts of an OAuth login the proxy needs, whichever CLI wrote it. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch, or null when the CLI didn't say. */
  expiresAt: number | null;
  /** ChatGPT's workspace id; Anthropic has none. */
  accountId: string | null;
  plan: string | null;
  /** OpenAI's OpenID token, which carries the account and plan claims. */
  idToken: string | null;
}

/**
 * One subscription provider: how its CLI stores a login, how to refresh it,
 * and what to put on upstream requests.
 */
export interface ProviderPlugin {
  readonly id: "anthropic" | "openai";
  /** Reads the tokens out of the CLI's document. Throws if it holds no login. */
  parse(text: string): OAuthTokens;
  /** Writes refreshed tokens into the document, keeping every other field. */
  merge(text: string, tokens: OAuthTokens): string;
  refresh(tokens: OAuthTokens, fetch: typeof globalThis.fetch): Promise<OAuthTokens>;
  /** The upstream URL for a path under this provider's proxy prefix. */
  upstream(path: string, search: string): string;
  /** Sets auth on an outgoing request's headers. */
  authorise(headers: Headers, tokens: OAuthTokens): void;
}

export function defineProvider(plugin: ProviderPlugin): ProviderPlugin {
  return plugin;
}

/** Decodes a JWT's payload without checking it; we only read our own tokens' claims. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
