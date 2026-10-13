import { z } from "zod";
import { defineProvider, isRecord, jwtClaims } from "./provider.ts";

export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_CLAIM = "https://api.openai.com/auth";

/** `~/.codex/auth.json`. */
const Document = z.looseObject({
  tokens: z.looseObject({
    id_token: z.string().nullish(),
    access_token: z.string(),
    refresh_token: z.string(),
    account_id: z.string().nullish(),
  }),
  last_refresh: z.string().nullish(),
});

const RefreshResponse = z.object({
  id_token: z.string().optional(),
  access_token: z.string(),
  refresh_token: z.string().optional(),
});

function authClaims(token: string | null | undefined): Record<string, unknown> {
  const claim = token ? jwtClaims(token)?.[AUTH_CLAIM] : undefined;
  return isRecord(claim) ? claim : {};
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === "string" ? v : null;
}

function expiry(accessToken: string): number | null {
  const exp = jwtClaims(accessToken)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export function openaiProvider(upstreamBase = "https://chatgpt.com/backend-api/codex") {
  return defineProvider({
    id: "openai",
    parse(text) {
      const doc = Document.parse(JSON.parse(text));
      const t = doc.tokens;
      const claims = authClaims(t.id_token);
      return {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: expiry(t.access_token),
        accountId: t.account_id ?? stringClaim(claims, "chatgpt_account_id"),
        plan: stringClaim(claims, "chatgpt_plan_type"),
        idToken: t.id_token ?? null,
      };
    },
    merge(text, tokens) {
      const doc = Document.parse(JSON.parse(text));
      return JSON.stringify(
        {
          ...doc,
          tokens: {
            ...doc.tokens,
            ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          },
          last_refresh: new Date().toISOString(),
        },
        null,
        2,
      );
    },
    async refresh(tokens, doFetch) {
      const res = await doFetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: OPENAI_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          scope: "openid profile email",
        }),
      });
      if (!res.ok) throw new Error(`OpenAI refused the refresh: ${res.status} ${await res.text()}`);
      const body = RefreshResponse.parse(await res.json());
      return {
        ...tokens,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? tokens.refreshToken,
        idToken: body.id_token ?? tokens.idToken,
        expiresAt: expiry(body.access_token),
      };
    },
    upstream(path, search) {
      return `${upstreamBase}${path}${search}`;
    },
    authorise(headers, tokens) {
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${tokens.accessToken}`);
      if (tokens.accountId) headers.set("chatgpt-account-id", tokens.accountId);
      else headers.delete("chatgpt-account-id");
    },
  });
}
