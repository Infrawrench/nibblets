/**
 * The placeholder ChatGPT login Codex runs with inside a nibblet. Both the
 * runner (which writes it) and the credential proxy (which answers Codex's
 * refreshes with it) use this one definition: if a refresh ever changes the
 * identity Codex sees, Codex treats it as an account switch and revokes its
 * own network access mid-turn.
 */

export const PLACEHOLDER_CODEX_ACCOUNT = "nibblet";

function base64url(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** An unsigned JWT carrying the proxy key in `nibblet_key`. Codex reads the account and plan from it. */
export function placeholderJwt(key: string, accountId = PLACEHOLDER_CODEX_ACCOUNT): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      exp: 4102444800,
      email: "nibblet@localhost",
      nibblet_key: key,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
    }),
    "nibblet",
  ].join(".");
}

/** `~/.codex/auth.json` for a runner: ChatGPT mode, every token a placeholder. */
export function placeholderCodexAuth(key: string, now = new Date()) {
  const jwt = placeholderJwt(key);
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt,
      access_token: jwt,
      refresh_token: key,
      account_id: PLACEHOLDER_CODEX_ACCOUNT,
    },
    last_refresh: now.toISOString(),
  };
}

/** What the proxy's `/openai-auth/oauth/token` answers a refresh with. */
export function placeholderCodexRefresh(key: string) {
  const jwt = placeholderJwt(key);
  return { id_token: jwt, access_token: jwt, refresh_token: key };
}
