import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KimiLogin } from "@nibblet/protocol";
import type { Run } from "./clis/cli.ts";

/**
 * The host's Kimi Code CLI setup, so a Kimi nibblet runs on the same Kimi
 * account as the user's own CLI. Kimi keeps its runtime config in
 * `config.toml` and its OAuth token in `credentials/`, both under
 * `$KIMI_CODE_HOME` (or `~/.kimi-code`).
 */
export interface KimiPaths {
  home: string;
  config: string;
  token: string;
}

export function kimiPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): KimiPaths {
  const base = env.KIMI_CODE_HOME ?? join(home, ".kimi-code");
  return {
    home: base,
    config: join(base, "config.toml"),
    // The name `/login` stores the managed account's token under.
    token: join(base, "credentials", "kimi-code.json"),
  };
}

export interface KimiHost {
  /** The CLI is on PATH, or there's a config or a login to share. */
  installed: boolean;
  /** The CLI's version, when the CLI itself is on PATH. */
  version: string | null;
  hasLogin: boolean;
  detail: string | null;
}

export async function detectKimi(run: Run, paths: KimiPaths = kimiPaths()): Promise<KimiHost> {
  const cli = await run("kimi", ["--version"]);
  const version = cli.code === 0 ? cli.stdout.trim().split(/\s+/).pop() || null : null;
  const hasConfig = existsSync(paths.config);
  const hasToken = existsSync(paths.token);
  const installed = version !== null || hasConfig || hasToken;
  return {
    installed,
    version,
    hasLogin: hasToken,
    detail: !installed
      ? "Kimi Code isn't set up on this machine"
      : !hasToken && !hasConfig
        ? "Sign in to Kimi Code first"
        : null,
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The host's Kimi Code config and OAuth token, as text. Secret: never logged. */
export async function readKimiLogin(paths: KimiPaths = kimiPaths()): Promise<KimiLogin> {
  return { config: await readIfPresent(paths.config), token: await readIfPresent(paths.token) };
}
