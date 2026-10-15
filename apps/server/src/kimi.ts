import { KimiLogin } from "@nibblet/protocol";
import { z } from "zod";
import { bridgeGet, type Bridge } from "./bridge.ts";

export const HostKimi = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  hasLogin: z.boolean(),
  detail: z.string().nullable(),
});

/**
 * The host's Kimi Code login, fetched fresh for each runner configure. Null
 * without a bridge or a token, in which case the runner says so rather than
 * guessing at credentials.
 */
export async function kimiLogin(
  config: Bridge,
  warn: (message: string) => void,
): Promise<KimiLogin | null> {
  if (!config.HOST_MCP_URL) return null;
  try {
    const login = KimiLogin.parse(await bridgeGet(config, "/harness/kimi/login"));
    return login.token === null ? null : login;
  } catch (err) {
    warn(
      `Couldn't fetch the host's Kimi Code login: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Why Kimi can't run on this host, or null when it can. */
export async function kimiUnavailable(config: Bridge): Promise<string | null> {
  if (!config.HOST_MCP_URL) return "The host bridge isn't set up";
  let host: z.infer<typeof HostKimi>;
  try {
    host = HostKimi.parse(await bridgeGet(config, "/harness/kimi"));
  } catch {
    return "The host bridge isn't connected";
  }
  if (!host.installed) return host.detail ?? "Kimi Code isn't set up on the host";
  if (!host.hasLogin) return host.detail ?? "Kimi Code isn't signed in on the host";
  return null;
}
