import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BRIDGE_PORT } from "./bridge.ts";

/** Where the desktop app serves the host's MCP servers and CLI logins. */
export const HOST_MCP_PORT = 8789;
import { claudeFile, codexFile, type DetectedCredentials } from "./credentials.ts";

export interface StackPaths {
  /** Where the compose project lives: the app's data directory. */
  dir: string;
  /** The compose file shipped with the app (or the repo's, in development). */
  composeSource: string;
  /** The repo root when running from a checkout; images are built from it. */
  sourceDir: string | null;
  /** Otherwise, the published images to pull: this release's, from the registry. */
  images: { prefix: string; tag: string } | null;
}

/** Where releases publish their images: `${prefix}server:${version}` and so on. */
export const IMAGE_PREFIX = "ghcr.io/infrawrench/nibblets-";

type EnvFile = Record<string, string>;

function parseEnv(text: string): EnvFile {
  const out: EnvFile = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

const secret = () => randomBytes(32).toString("hex");

/** The keys of `env` that are set, for carrying hand-added lines over. */
function keep(env: EnvFile, ...keys: string[]): EnvFile {
  return Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k] ?? ""]));
}

/**
 * The compose project in the app's data directory: the shipped compose
 * file, an .env whose secrets are made once and kept, and an override that
 * mounts the logins this machine has.
 */
export class Stack {
  readonly paths: StackPaths;
  private readonly cli: string;
  /** Nibblets Connect, for the server to link to; its own default when unset. */
  centralUrl: string | null = null;
  env: EnvFile = {};

  constructor(paths: StackPaths, cli: string) {
    this.paths = paths;
    this.cli = cli;
  }

  async prepare(creds: DetectedCredentials): Promise<void> {
    const { dir } = this.paths;
    await mkdir(dir, { recursive: true });
    await copyFile(this.paths.composeSource, join(dir, "compose.yaml"));

    const envPath = join(dir, ".env");
    const existing = existsSync(envPath) ? parseEnv(await readFile(envPath, "utf8")) : {};
    this.env = {
      POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD ?? secret(),
      CREDPROXY_KEY: existing.CREDPROXY_KEY ?? secret(),
      CREDPROXY_ADMIN_KEY: existing.CREDPROXY_ADMIN_KEY ?? secret(),
      NIBBLET_OWNER_TOKEN: existing.NIBBLET_OWNER_TOKEN ?? secret(),
      KEYCHAIN_BRIDGE_TOKEN: existing.KEYCHAIN_BRIDGE_TOKEN ?? secret(),
      HOST_MCP_TOKEN: existing.HOST_MCP_TOKEN ?? secret(),
      HOST_MCP_URL: `http://host.docker.internal:${HOST_MCP_PORT}`,
      // Docker Desktop and OrbStack forward the host's agent at this path in their VM.
      // Who this machine is, for Nibblets Connect; the container can't see it.
      NIBBLET_HOST_NAME: hostname(),
      NIBBLET_HOST_PLATFORM: ["darwin", "linux", "win32"].includes(process.platform)
        ? process.platform
        : "other",
      ...(this.centralUrl ? { NIBBLET_CENTRAL_URL: this.centralUrl } : {}),
      HOST_SSH_AUTH_SOCK:
        process.platform === "linux"
          ? (process.env.SSH_AUTH_SOCK ?? "")
          : "/run/host-services/ssh-auth.sock",
      // An API key, chosen by hand instead of a login, wins over what's detected.
      CLAUDE_CREDENTIALS_SOURCE:
        existing.CLAUDE_CREDENTIALS_SOURCE === "api-key"
          ? "api-key"
          : creds.claude === "none"
            ? "auto"
            : creds.claude,
      CODEX_AUTH_SOURCE:
        existing.CODEX_AUTH_SOURCE === "api-key"
          ? "api-key"
          : creds.codex === "none"
            ? "auto"
            : creds.codex,
      KEYCHAIN_BRIDGE_URL:
        creds.claude === "keychain" ? `http://host.docker.internal:${BRIDGE_PORT}` : "",
      // Added by hand, so they have to survive this rewrite.
      ...keep(existing, "DEEPSEEK_API_KEY", "NIBBLET_ANTHROPIC_API_KEY", "NIBBLET_OPENAI_API_KEY"),
      ...(this.paths.sourceDir ? { NIBBLET_SOURCE_DIR: this.paths.sourceDir } : {}),
      ...(this.paths.images
        ? { NIBBLET_IMAGE_PREFIX: this.paths.images.prefix, NIBBLET_TAG: this.paths.images.tag }
        : {}),
    };
    const envText = Object.entries(this.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await writeFile(envPath, `${envText}\n`, { mode: 0o600 });

    // Long-form binds, because a Windows path's drive letter breaks `src:dst`.
    const bind = (source: string, target: string) => [
      "      - type: bind",
      `        source: ${JSON.stringify(source)}`,
      `        target: ${target}`,
    ];
    const mounts = [
      ...(creds.claude === "file" ? bind(claudeFile, "/creds/claude/.credentials.json") : []),
      ...(creds.codex === "file" ? bind(codexFile, "/creds/codex/auth.json") : []),
    ];
    const override = [
      "# Written by the nibblet desktop app on each start.",
      "services:",
      "  credproxy:",
      "    volumes:",
      ...(mounts.length ? mounts : ["      []"]),
      "",
    ].join("\n");
    await writeFile(join(dir, "compose.creds.yaml"), override);
  }

  /** Builds from source in a checkout; otherwise pulls the published images. */
  async up(onLine: (line: string) => void): Promise<void> {
    if (this.paths.sourceDir) {
      await this.compose(["--profile", "build", "build", "runner"], onLine);
      await this.compose(["up", "-d", "--build", "--remove-orphans"], onLine);
    } else {
      await this.compose(["--profile", "build", "pull", "--ignore-pull-failures"], onLine);
      await this.compose(["up", "-d", "--remove-orphans"], onLine);
    }
  }

  /** Calls the local server's API as its owner, for the app's own prompts. */
  async rpc(path: string, input: object = {}): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:8420/api/rpc/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.NIBBLET_OWNER_TOKEN ?? ""}`,
      },
      body: JSON.stringify(input),
    });
    const body: unknown = await res.json();
    return body;
  }

  down(onLine: (line: string) => void): Promise<void> {
    return this.compose(["stop"], onLine);
  }

  /** Resolves once the server answers, which can lag `compose up` when it was recreated. */
  async waitForServer(timeoutMs = 90_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const res = await fetch("http://127.0.0.1:8420/healthz");
        if (res.ok) return true;
      } catch {
        // Not up yet.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /** Waits for the server, then asks it for a one-time sign-in link. */
  async pairingUrl(): Promise<string> {
    await this.waitForServer();
    let out = "";
    await this.compose(
      ["exec", "-T", "server", "node", "apps/server/src/cli.ts", "pair"],
      (line) => {
        out += `${line}\n`;
      },
    );
    const url = /(https?:\/\/\S+#pair=\S+)/.exec(out)?.[1];
    if (!url) throw new Error(`The server didn't give a sign-in link:\n${out}`);
    // The server names its public URL; the desktop app always talks to loopback.
    const fragment = url.slice(url.indexOf("#"));
    return `http://127.0.0.1:8420/${fragment}`;
  }

  private compose(args: string[], onLine: (line: string) => void): Promise<void> {
    const { dir } = this.paths;
    const full = [
      "compose",
      "-p",
      "nibblet",
      "-f",
      "compose.yaml",
      "-f",
      "compose.creds.yaml",
      ...args,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, full, { cwd: dir, env: { ...process.env, ...this.env } });
      const lines = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLine(line);
      };
      child.stdout.on("data", lines);
      child.stderr.on("data", lines);
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`docker compose ${args[0] ?? ""} exited with ${code}`)),
      );
    });
  }
}
