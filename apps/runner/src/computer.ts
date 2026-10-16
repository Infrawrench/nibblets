/**
 * OpenComputerUse (0.7 or later), the nibblet's browser, on a headless
 * Wayland display.
 *
 * One OCU process runs for the life of the container so the agent (over
 * MCP) and the person watching (over the view socket on port 7900, proxied
 * by the server) see the same sessions. If `serve` mode doesn't come up,
 * the harness gets OCU over stdio instead, which works but has no view.
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
 * Overrides: `OCU_CMD` (default `opencomputeruse`), `OCU_ARGS` (space
 * separated), `OCU_MCP_URL`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { McpServerSpec } from "@nibblet/harness";
import { BROWSER_MCP_PORT, VIEW_PORT } from "@nibblet/protocol";

// The tokens go in the environment (OCU_SERVE_TOKEN, OCU_VIEW_TOKEN), never
// the command line, which every process in the container can read.
const DEFAULT_PORTS = { mcp: BROWSER_MCP_PORT, view: VIEW_PORT };

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

export interface ComputerOptions {
  /** The MCP endpoint's token; a new one, kept in this process, unless given. */
  token?: string;
  /** Its environment, and so the apps' it starts; this process's unless given. */
  env?: NodeJS.ProcessEnv;
  /** Where it, and the apps it starts, run. */
  cwd?: string;
  /** Its arguments, rather than `OCU_ARGS` or the usual ones. */
  args?: string[];
}

export async function startComputer(
  viewToken: string,
  log: (level: "info" | "warn", message: string) => void,
  ports: { mcp: number; view: number } = DEFAULT_PORTS,
  opts: ComputerOptions = {},
): Promise<Computer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const command = process.env.OCU_CMD ?? "opencomputeruse";
  const args =
    opts.args ??
    (process.env.OCU_ARGS ?? `serve --port ${ports.mcp} --view-listen 0.0.0.0:${ports.view}`)
      .split(" ")
      .filter(Boolean);
  const tokens = { OCU_SERVE_TOKEN: token, OCU_VIEW_TOKEN: viewToken };
  const url = process.env.OCU_MCP_URL ?? `http://127.0.0.1:${ports.mcp}/mcp`;
  const stdio: Computer = {
    mcp: {
      type: "stdio",
      command,
      args: ["mcp", "--view-listen", `0.0.0.0:${ports.view}`],
      env: { OCU_LINUX_DISPLAY: "wayland", OCU_VIEW_TOKEN: viewToken },
    },
    stop() {},
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...(opts.env ?? process.env), ...tokens, OCU_LINUX_DISPLAY: "wayland" },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch (err) {
    log("warn", `OpenComputerUse serve failed to start (${String(err)}); using stdio`);
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

  if (!(await waitForHttp(url, () => exited))) {
    log("warn", "OpenComputerUse serve mode didn't come up; using stdio");
    if (!exited) child.kill();
    return stdio;
  }
  log("info", `OpenComputerUse serving MCP at ${url}`);
  return {
    mcp: { type: "http", url, headers: { authorization: `Bearer ${token}` } },
    stop: () => child.kill(),
  };
}

async function waitForHttp(
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
