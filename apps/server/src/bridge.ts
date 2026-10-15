import type { Config } from "./config.ts";

export type Bridge = Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">;

/** A JSON GET to the host bridge, as the server's own owner. */
export async function bridgeGet(config: Bridge, path: string): Promise<unknown> {
  const res = await fetch(`${config.HOST_MCP_URL}${path}`, {
    headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
