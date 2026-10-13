import { CliLogin, CliStatuses } from "@nibblet/protocol";
import { z } from "zod";
import type { Config } from "./config.ts";

type Fetch = typeof fetch;

const CredentialBody = CliLogin.omit({ id: true });

/**
 * Borrowed host CLI logins for one nibblet: fetched fresh from the host
 * bridge for exactly the CLIs ticked for it, so a rotated token reaches the
 * runner on its next configure. A CLI that can't hand one out is skipped.
 */
export async function cliLogins(
  config: Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">,
  ticked: readonly string[],
  warn: (message: string) => void,
  doFetch: Fetch = fetch,
): Promise<CliLogin[]> {
  if (!config.HOST_MCP_URL || ticked.length === 0) return [];
  const logins = await Promise.all(
    ticked.map(async (id): Promise<CliLogin | null> => {
      try {
        const res = await doFetch(
          `${config.HOST_MCP_URL}/clis/${encodeURIComponent(id)}/credential`,
          {
            headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { id, ...CredentialBody.parse(await res.json()) };
      } catch (err) {
        warn(
          `Couldn't borrow the ${id} login: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  return logins.filter((l) => l !== null);
}

export async function cliStatuses(
  config: Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">,
): Promise<CliStatuses> {
  if (!config.HOST_MCP_URL)
    return { connected: false, detail: "No host bridge is configured", clis: [] };
  try {
    const res = await fetch(`${config.HOST_MCP_URL}/clis`, {
      headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      connected: true,
      detail: null,
      clis: z.array(CliStatuses.shape.clis.element).parse(await res.json()),
    };
  } catch (err) {
    const detail = `Host bridge unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return { connected: false, detail, clis: [] };
  }
}
