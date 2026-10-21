/**
 * OpenComputerUse (0.7 or later), the nibblet's browser, on a headless
 * Wayland display.
 *
 * One OCU process runs for the life of the container so the agent (over
 * MCP) and the person watching (over the view socket on port 7900, proxied
 * by the server) see the same sessions. If `serve` mode doesn't come up,
 * the harness gets OCU over stdio instead, which works but has no view
 * (unless that's turned off, as it is for the desktop).
 *
 * The MCP endpoint listens on loopback only, with a token that never leaves
 * the container. The view server listens on 0.0.0.0:7900 and takes
 * `NIBBLET_VIEW_TOKEN`; the server proxies `/api/nibblets/:id/computer/*` to
 * it with that bearer.
 *
 * A sub-agent runs its own beside its parent's, in the same container, on
 * the ports it's given: its own browser, with its own profile.
 *
 * The runner starts another, the desktop (see desktop.ts), for the agent's
 * other apps, as the agent's own user.
 *
 * Overrides: `OCU_CMD` (default `opencomputeruse`), `OCU_CMD_ARGS` (a JSON
 * array of arguments before its own, for a command that starts it: on
 * Windows, runas into the signed-in session), `OCU_ARGS` (space separated),
 * `OCU_MCP_URL`. The first two can be given as `via` instead.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "@nibblet/harness";
import { BROWSER_MCP_PORT, VIEW_PORT } from "@nibblet/protocol";
import { z } from "zod";

// The tokens go in the environment (OCU_SERVE_TOKEN, OCU_VIEW_TOKEN), never
// the command line, which every process in the container can read.
const DEFAULT_PORTS = { mcp: BROWSER_MCP_PORT, view: VIEW_PORT };
/** How long it has to come up through a wrapper: the session runas waits for (three minutes), and then some. */
const WRAPPED_START_MS = 4 * 60_000;

export interface Computer {
  mcp: McpServerSpec;
  stop(): void;
}

/**
 * Removes the lock a Chromium that didn't shut down cleanly (killed with its
 * container, or the machine losing power) leaves in its profile. The lock
 * names the host it was taken on, and every container gets a new hostname,
 * so the next Chromium takes the profile for one in use on another computer
 * and quits, leaving the nibblet with no browser until the lock goes. Call it
 * before the browser starts: the profile is this guard's alone, so nothing
 * else can be holding it.
 */
export async function clearProfileLock(home: string): Promise<void> {
  // Chromium's default; the entry never gives the guard an XDG_CONFIG_HOME.
  const profile = path.join(home, ".config", "chromium");
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    // They're symlinks, mostly to things that are gone: rm doesn't follow them.
    await rm(path.join(profile, name), { force: true });
  }
}

/**
 * Its environment, without the nibblet's own settings and secrets: it needs
 * none of them, and where it runs as the agent's user (Windows, macOS), a
 * process of that user's can read another's environment.
 */
function ocuEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("NIBBLET_")));
}

export interface ComputerOptions {
  /** The MCP endpoint's token; a new one, kept in this process, unless given. */
  token?: string;
  /** Its environment, and so the apps' it starts; this process's unless given. */
  env?: NodeJS.ProcessEnv;
  /** Where it, and the apps it starts, run. */
  cwd?: string;
  /** Its arguments, rather than `OCU_ARGS` or `serveArgs`. */
  args?: string[];
  /** Whether the harness should run OCU over stdio when `serve` doesn't come up, rather than none. */
  stdio?: boolean;
  /** What starts it, with the arguments before its own, rather than `OCU_CMD` and `OCU_CMD_ARGS`. */
  via?: OcuCommand;
}

export interface OcuCommand {
  command: string;
  args: readonly string[];
}

/** What starts OpenComputerUse, from `OCU_CMD` and `OCU_CMD_ARGS`. */
export function ocuCommand(env: NodeJS.ProcessEnv = process.env): OcuCommand {
  return {
    command: env.OCU_CMD ?? "opencomputeruse",
    args: env.OCU_CMD_ARGS ? z.array(z.string()).parse(JSON.parse(env.OCU_CMD_ARGS)) : [],
  };
}

/**
 * `serve`'s arguments: MCP on loopback (it listens on every address unless
 * told otherwise) and the view on every address, for the server.
 */
export function serveArgs(ports: { mcp: number; view: number }): string[] {
  return [
    "serve",
    "--port",
    String(ports.mcp),
    "--listen-on",
    "127.0.0.1",
    "--view-listen",
    `0.0.0.0:${ports.view}`,
  ];
}

export async function startComputer(
  viewToken: string,
  log: (level: "info" | "warn", message: string) => void,
  ports: { mcp: number; view: number } = DEFAULT_PORTS,
  opts: ComputerOptions = {},
): Promise<Computer | null> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const { command, args: lead } = opts.via ?? ocuCommand();
  const args = [
    ...lead,
    ...(opts.args ?? process.env.OCU_ARGS?.split(" ").filter(Boolean) ?? serveArgs(ports)),
  ];
  const tokens = { OCU_SERVE_TOKEN: token, OCU_VIEW_TOKEN: viewToken };
  const url = process.env.OCU_MCP_URL ?? `http://127.0.0.1:${ports.mcp}/mcp`;
  const stdio: Computer | null =
    opts.stdio === false
      ? null
      : {
          mcp: {
            type: "stdio",
            command,
            args: [...lead, "mcp", "--view-listen", `0.0.0.0:${ports.view}`],
            env: { OCU_LINUX_DISPLAY: "wayland", OCU_VIEW_TOKEN: viewToken },
          },
          stop() {},
        };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...ocuEnv(opts.env ?? process.env), ...tokens, OCU_LINUX_DISPLAY: "wayland" },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch (err) {
    log(
      "warn",
      `OpenComputerUse serve failed to start (${String(err)})${stdio ? "; using stdio" : ""}`,
    );
    return stdio;
  }
  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    log("warn", `OpenComputerUse exited with code ${code}`);
  });
  child.once("error", (err) => {
    exited = true;
    log("warn", `OpenComputerUse: ${err.message}`);
  });

  // Through a wrapper (runas into Windows' signed-in session), it can't start
  // before the session has: a first boot's sign-in, making its profile, takes
  // minutes, which runas waits out.
  if (!(await waitForHttp(url, () => exited, lead.length > 0 ? WRAPPED_START_MS : 15_000))) {
    log("warn", `OpenComputerUse serve mode didn't come up${stdio ? "; using stdio" : ""}`);
    if (!exited) child.kill();
    return stdio;
  }
  log("info", `OpenComputerUse serving MCP at ${url}`);
  return {
    mcp: { type: "http", url, headers: { authorization: `Bearer ${token}` } },
    stop: () => child.kill(),
  };
}

/** Waits for an HTTP server at `url` to answer at all, until `gaveUp` or the timeout. */
export async function waitForHttp(
  url: string,
  gaveUp: () => boolean,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !gaveUp()) {
    try {
      // Any HTTP answer, even an error status, means the server is listening.
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}
