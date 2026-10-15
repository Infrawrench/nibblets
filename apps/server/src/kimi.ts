import { KimiLogin } from "@nibblet/protocol";
import type { Config } from "./config.ts";

type Bridge = Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">;

async function bridgeGet(config: Bridge, path: string): Promise<unknown> {
  const res = await fetch(`${config.HOST_MCP_URL}${path}`, {
    headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The host's Kimi Code login, fetched fresh for each runner configure. Null
 * without a bridge or a login, in which case the runner says so rather than
 * guessing at credentials.
 */
export async function kimiLogin(
  config: Bridge,
  warn: (message: string) => void,
): Promise<KimiLogin | null> {
  if (!config.HOST_MCP_URL) return null;
  try {
    const login = KimiLogin.parse(await bridgeGet(config, "/harness/kimi/login"));
    return login.config === null && login.token === null ? null : login;
  } catch (err) {
    warn(
      `Couldn't fetch the host's Kimi Code login: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
