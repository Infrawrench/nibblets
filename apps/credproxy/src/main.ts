// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "./app.ts";
import { serverBudgets } from "./budgets.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { anthropicKeyProvider, openaiKeyProvider } from "./providers/apikey.ts";
import { deepseekProvider } from "./providers/deepseek.ts";
import { openaiProvider } from "./providers/openai.ts";
import { fileSource } from "./sources/file.ts";
import { keychainSource } from "./sources/keychain.ts";
import type { CredentialSource } from "./sources/source.ts";
import { TokenManager } from "./tokens.ts";

// `api-key` uses the provider's API key instead of a subscription login.
const SourceMode = z.enum(["auto", "file", "keychain", "api-key", "none"]).default("auto");

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  CREDPROXY_KEY: z.string().min(16),
  CREDPROXY_ADMIN_KEY: z.string().min(16),
  CLAUDE_CREDENTIALS_FILE: z.string().default("/creds/claude/.credentials.json"),
  CODEX_AUTH_FILE: z.string().default("/creds/codex/auth.json"),
  CLAUDE_CREDENTIALS_SOURCE: SourceMode,
  CODEX_AUTH_SOURCE: SourceMode,
  KEYCHAIN_BRIDGE_URL: z.string().optional(),
  KEYCHAIN_BRIDGE_TOKEN: z.string().optional(),
  // Where nibblets' budgets for API keys are kept.
  NIBBLET_SERVER_URL: z.string().default("http://server:8420"),
  // Compose passes these through empty when they aren't set. Not
  // ANTHROPIC_API_KEY and OPENAI_API_KEY, which the host's own CLIs would
  // pick up from the .env the host bridge loads.
  DEEPSEEK_API_KEY: z.string().optional(),
  NIBBLET_ANTHROPIC_API_KEY: z.string().optional(),
  NIBBLET_OPENAI_API_KEY: z.string().optional(),
});

const env = Env.parse(process.env);

type Keychain = ReturnType<typeof keychainSource>;
const keychains = new Map<"anthropic" | "openai", Keychain>();

/**
 * `auto` uses the file when it's mounted, else the keychain when the
 * desktop app's bridge is configured (macOS keeps Claude's login in the
 * keychain), else the file path anyway, so the status page names what's
 * missing.
 */
function pickSource(
  provider: "anthropic" | "openai",
  mode: Exclude<z.infer<typeof SourceMode>, "api-key">,
  file: string,
): CredentialSource | null {
  const keychain = () => {
    const source = keychainSource({
      provider,
      bridgeUrl: env.KEYCHAIN_BRIDGE_URL ?? null,
      bridgeToken: env.KEYCHAIN_BRIDGE_TOKEN ?? null,
    });
    keychains.set(provider, source);
    return source;
  };
  switch (mode) {
    case "none":
      return null;
    case "file":
      return fileSource(file);
    case "keychain":
      return keychain();
    case "auto":
      if (existsSync(file)) return fileSource(file);
      return env.KEYCHAIN_BRIDGE_URL ? keychain() : fileSource(file);
  }
}

const apiKey = (value: string | undefined) => value?.trim() || null;

const anthropic =
  env.CLAUDE_CREDENTIALS_SOURCE === "api-key"
    ? anthropicKeyProvider(apiKey(env.NIBBLET_ANTHROPIC_API_KEY))
    : new TokenManager({
        provider: anthropicProvider(),
        source: pickSource("anthropic", env.CLAUDE_CREDENTIALS_SOURCE, env.CLAUDE_CREDENTIALS_FILE),
      });
const openai =
  env.CODEX_AUTH_SOURCE === "api-key"
    ? openaiKeyProvider(apiKey(env.NIBBLET_OPENAI_API_KEY))
    : new TokenManager({
        provider: openaiProvider(),
        source: pickSource("openai", env.CODEX_AUTH_SOURCE, env.CODEX_AUTH_FILE),
      });

const deepseek = deepseekProvider(apiKey(env.DEEPSEEK_API_KEY));

const app = createApp({
  key: env.CREDPROXY_KEY,
  adminKey: env.CREDPROXY_ADMIN_KEY,
  anthropic,
  openai,
  deepseek,
  budgets: serverBudgets({ serverUrl: env.NIBBLET_SERVER_URL, adminKey: env.CREDPROXY_ADMIN_KEY }),
  push(provider, text) {
    const keychain = keychains.get(provider);
    if (!keychain) return false;
    keychain.remember(text);
    return true;
  },
});

serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`credproxy listening on :${info.port}`);
  for (const m of [anthropic, openai]) {
    void Promise.resolve(m.status()).then((s) =>
      console.log(`${s.provider}: ${s.ok ? "ok" : "not ready"}, ${s.detail}`),
    );
  }
  if (deepseek.key) console.log("deepseek: ok, API key set");
});
