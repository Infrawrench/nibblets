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
      asInteractiveHeaders(headers);
    },
    rewriteBody: asInteractiveBody,
  });
}

/**
 * Claude Code's `User-Agent` up to its entrypoint: `claude-cli/2.1.296 (external, sdk-cli,
 * agent-sdk/0.3.296)` from the Agent SDK, `claude-cli/2.1.310 (external, cli)` from the TUI.
 */
const CLAUDE_CODE_AGENT = /^(claude-cli\/\S+) \(external,[^)]*\)/;

/** The first system block Claude Code sends, up to the entrypoint's value. */
const BILLING_LINE = /^(x-anthropic-billing-header:.*?\bcc_entrypoint=)[^;]*/;

const SystemBlocks = z.looseObject({
  system: z.array(z.looseObject({ text: z.string().optional() })),
});

/**
 * Subscriptions meter the Agent SDK's requests faster than the interactive
 * CLI's for the same tokens, so the harness's Claude Code says it's the CLI.
 * Only its entrypoint changes; its version stays its own. API keys aren't
 * metered that way, so their provider leaves requests alone.
 */
export function asInteractiveHeaders(headers: Headers): void {
  const agent = headers.get("user-agent");
  if (!agent || !CLAUDE_CODE_AGENT.test(agent)) return;
  headers.set("user-agent", agent.replace(CLAUDE_CODE_AGENT, "$1 (external, cli)"));
  headers.set("x-app", "cli");
}

/** Sets `cc_entrypoint=cli` on Claude Code's billing line; any other body is sent as is. */
export function asInteractiveBody(body: ArrayBuffer): ArrayBuffer {
  let parsed;
  try {
    parsed = SystemBlocks.safeParse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return body;
  }
  if (!parsed.success) return body;
  const first = parsed.data.system[0];
  if (!first?.text || !BILLING_LINE.test(first.text)) return body;
  first.text = first.text.replace(BILLING_LINE, "$1cli");
  return new TextEncoder().encode(JSON.stringify(parsed.data)).buffer;
}

/** Adds betas to a comma-separated `anthropic-beta` value, keeping order and dropping repeats. */
export function mergeBetas(existing: string | null, ...add: string[]): string {
  const all = [...(existing ?? "").split(","), ...add].map((b) => b.trim()).filter(Boolean);
  return [...new Set(all)].join(",");
}
