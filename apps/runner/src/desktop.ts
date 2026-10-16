/**
 * The desktop: a second OpenComputerUse, for the container's apps other
 * than the browser, run by the runner as the agent's own user. The
 * browser's runs as the guard, which holds its logins and secrets, and
 * every app OpenComputerUse starts runs as the user it runs as, with its
 * environment. So an app the user or the agent opens here can do no more
 * than the agent could from its shell.
 *
 * Its MCP endpoint is on loopback (`DESKTOP_MCP_PORT`) and its view server
 * on `DESKTOP_VIEW_PORT`, which the server proxies at
 * `/api/nibblets/:id/desktop/*`. Both take `NIBBLET_DESKTOP_TOKEN`, which
 * the server derives: the agent may know it.
 *
 * One per container. The top-level runner starts it; a sub-agent's runner
 * joins it, so sub-agents share their host's apps (as they do its files).
 */
import type { McpServerSpec } from "@nibblet/harness";
import { DESKTOP_MCP_PORT, DESKTOP_VIEW_PORT } from "@nibblet/protocol";
import { serveArgs, startComputer, waitForHttp, type Computer } from "./computer.ts";

/** Where the runner reaches the desktop's view server, to start apps on it. */
export const DESKTOP_VIEW_URL = `http://127.0.0.1:${DESKTOP_VIEW_PORT}`;

/**
 * The runner's environment for the apps, without what's the runner's alone:
 * the agent can reach those anyway, but an app has no use for them. The
 * image sets no locale, and terminals and editors want a UTF-8 one.
 */
export function desktopEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("NIBBLET_"))),
    LANG: env.LANG || "C.UTF-8",
  };
}

/** Starts the container's desktop; null when it doesn't come up, and then there's none. */
export async function startDesktop(
  token: string,
  workdir: string,
  log: (level: "info" | "warn", message: string) => void,
): Promise<Computer | null> {
  const ports = { mcp: DESKTOP_MCP_PORT, view: DESKTOP_VIEW_PORT };
  // No stdio fallback: one in each harness would be no one else's, and a
  // sub-agent or the user would find nothing at these ports.
  return startComputer(token, (level, message) => log(level, `desktop: ${message}`), ports, {
    token,
    env: desktopEnv(process.env),
    cwd: workdir,
    args: serveArgs(ports),
    stdio: false,
  });
}

/** A sub-agent's way in to its host's desktop; null when that isn't answering. */
export async function joinDesktop(token: string): Promise<McpServerSpec | null> {
  const url = `http://127.0.0.1:${DESKTOP_MCP_PORT}/mcp`;
  if (!(await waitForHttp(url, () => false))) return null;
  return { type: "http", url, headers: { authorization: `Bearer ${token}` } };
}
