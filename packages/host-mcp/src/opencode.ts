import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpencodeLogin } from "@nibblet/protocol";
import type { Run } from "./clis/cli.ts";

/**
 * The host's OpenCode setup, so an OpenCode nibblet runs on the same
 * account and providers as the user's own OpenCode. OpenCode keeps its
 * config and logins in XDG directories on every platform.
 */
export interface OpencodePaths {
  configs: string[];
  auth: string;
}

export function opencodePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): OpencodePaths {
  const config = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
  const data = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode");
  return {
    // OpenCode reads all three, later ones winning; the bridge sends the first it finds.
    configs: ["opencode.jsonc", "opencode.json", "config.json"].map((f) => join(config, f)),
    auth: join(data, "auth.json"),
  };
}

export interface OpencodeHost {
  /** The CLI, the desktop app, or a config or login is on this machine. */
  installed: boolean;
  /** The CLI's version, when the CLI itself is on PATH. */
  version: string | null;
  /** There's a config or a login to share. */
  hasLogin: boolean;
  detail: string | null;
}

const APP_PATHS = ["/Applications/OpenCode.app", join(homedir(), "Applications", "OpenCode.app")];

export async function detectOpencode(
  run: Run,
  paths: OpencodePaths = opencodePaths(),
  appPaths: readonly string[] = process.platform === "darwin" ? APP_PATHS : [],
): Promise<OpencodeHost> {
  const cli = await run("opencode", ["--version"]);
  const version = cli.code === 0 ? cli.stdout.trim().split(/\s+/).pop() || null : null;
  const app = appPaths.some((p) => existsSync(p));
  const hasLogin = existsSync(paths.auth) || paths.configs.some((p) => existsSync(p));
  const installed = version !== null || app || hasLogin;
  return {
    installed,
    version,
    hasLogin,
    detail: !installed
      ? "OpenCode isn't set up on this machine"
      : hasLogin
        ? null
        : "Sign in to a provider in OpenCode first",
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The host's OpenCode config and auth.json, as text. Secret: never logged. */
export async function readOpencodeLogin(
  paths: OpencodePaths = opencodePaths(),
): Promise<OpencodeLogin> {
  let config: string | null = null;
  for (const p of paths.configs) {
    config = await readIfPresent(p);
    if (config !== null) break;
  }
  return { config, auth: await readIfPresent(paths.auth) };
}
