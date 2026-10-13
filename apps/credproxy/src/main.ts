import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApp } from "./app.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiProvider } from "./providers/openai.ts";
import { fileSource } from "./sources/file.ts";
import { keychainSource } from "./sources/keychain.ts";
import type { CredentialSource } from "./sources/source.ts";
import { TokenManager } from "./tokens.ts";

const SourceMode = z.enum(["auto", "file", "keychain", "none"]).default("auto");

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
  mode: z.infer<typeof SourceMode>,
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

const anthropic = new TokenManager({
  provider: anthropicProvider(),
  source: pickSource("anthropic", env.CLAUDE_CREDENTIALS_SOURCE, env.CLAUDE_CREDENTIALS_FILE),
});
const openai = new TokenManager({
  provider: openaiProvider(),
  source: pickSource("openai", env.CODEX_AUTH_SOURCE, env.CODEX_AUTH_FILE),
});

const app = createApp({
  key: env.CREDPROXY_KEY,
  adminKey: env.CREDPROXY_ADMIN_KEY,
  anthropic,
  openai,
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
    void m
      .status()
      .then((s) => console.log(`${s.provider}: ${s.ok ? "ok" : "not ready"}, ${s.detail}`));
  }
});
