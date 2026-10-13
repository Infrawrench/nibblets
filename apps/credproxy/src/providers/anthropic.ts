import { z } from "zod";
import { defineProvider } from "./provider.ts";

export const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA = "oauth-2025-04-20";

/** `~/.claude/.credentials.json`, and the keychain item, which holds the same JSON. */
const Document = z.looseObject({
  claudeAiOauth: z.looseObject({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    scopes: z.array(z.string()).nullish(),
  }),
});

const RefreshResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export function anthropicProvider(upstreamBase = "https://api.anthropic.com") {
  return defineProvider({
    id: "anthropic",
    parse(text) {
      const doc = Document.parse(JSON.parse(text));
      const o = doc.claudeAiOauth;
      return {
        accessToken: o.accessToken,
        refreshToken: o.refreshToken,
        expiresAt: o.expiresAt ?? null,
        accountId: null,
        plan: o.subscriptionType ?? null,
        idToken: null,
      };
    },
    merge(text, tokens) {
      const doc = Document.parse(JSON.parse(text));
      const next = {
        ...doc,
        claudeAiOauth: {
          ...doc.claudeAiOauth,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      };
      return JSON.stringify(next);
    },
    async refresh(tokens, doFetch) {
      const res = await doFetch(ANTHROPIC_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: ANTHROPIC_CLIENT_ID,
        }),
      });
      if (!res.ok)
        throw new Error(`Anthropic refused the refresh: ${res.status} ${await res.text()}`);
      const body = RefreshResponse.parse(await res.json());
      return {
        ...tokens,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? tokens.refreshToken,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
      };
    },
    upstream(path, search) {
      return `${upstreamBase}${path}${search}`;
    },
    authorise(headers, tokens) {
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${tokens.accessToken}`);
      headers.set("anthropic-beta", mergeBetas(headers.get("anthropic-beta"), OAUTH_BETA));
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    },
  });
}

/** Adds betas to a comma-separated `anthropic-beta` value, keeping order and dropping repeats. */
export function mergeBetas(existing: string | null, ...add: string[]): string {
  const all = [...(existing ?? "").split(","), ...add].map((b) => b.trim()).filter(Boolean);
  return [...new Set(all)].join(",");
}
