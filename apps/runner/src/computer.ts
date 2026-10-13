/**
 * OpenComputerUse, the nibblet's browser. Kept in one module because its
 * long-lived mode is still settling: OCU is gaining a Wayland backend and a
 * view socket, and the exact command line may change.
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
 * Overrides: `OCU_CMD` (default `opencomputeruse`), `OCU_ARGS` (space
 * separated; `{token}` and `{viewToken}` are filled in), `OCU_MCP_URL`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { McpServerSpec } from "@nibblet/harness";

const DEFAULT_ARGS =
  "serve --listen 127.0.0.1:7800 --token {token} --view-listen 0.0.0.0:7900 --view-token {viewToken} --linux-display wayland";
const DEFAULT_MCP_URL = "http://127.0.0.1:7800/mcp";

export interface Computer {
  mcp: McpServerSpec;
  stop(): void;
}

export async function startComputer(
  viewToken: string,
  log: (level: "info" | "warn", message: string) => void,
): Promise<Computer> {
  const token = randomBytes(24).toString("base64url");
  const command = process.env.OCU_CMD ?? "opencomputeruse";
  const args = (process.env.OCU_ARGS ?? DEFAULT_ARGS)
    .split(" ")
    .filter(Boolean)
    .map((a) => a.replaceAll("{token}", token).replaceAll("{viewToken}", viewToken));
  const url = process.env.OCU_MCP_URL ?? DEFAULT_MCP_URL;
  const stdio: Computer = {
    mcp: { type: "stdio", command, args: ["mcp"], env: { OCU_LINUX_DISPLAY: "wayland" } },
    stop() {},
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
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
