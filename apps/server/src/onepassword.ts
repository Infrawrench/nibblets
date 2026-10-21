import {
  OnePasswordGrants,
  OnePasswordStatus,
  RpcError,
  SharedVault,
  type VaultGrant,
} from "@nibblets/protocol";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";

/**
 * 1Password vaults shared with nibblets. The host bridge does the work (it
 * holds the 1Password CLI and each nibblet's token); the server keeps which
 * vaults are ticked for which nibblet, and fetches a nibblet's token only
 * when configuring its runner, where it's sent over the runner socket and
 * nowhere else.
 */

type BridgeConfig = Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">;

const SETTING = "onepasswordGrants";

function bridge(config: BridgeConfig, path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.HOST_MCP_URL) throw new RpcError("unavailable", "No host bridge is configured");
  return fetch(`${config.HOST_MCP_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.HOST_MCP_TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
    // Creating an account can wait on the 1Password app's approval prompt.
    signal: AbortSignal.timeout(120_000),
  });
}

export async function onePasswordStatus(config: BridgeConfig): Promise<OnePasswordStatus> {
  if (!config.HOST_MCP_URL) {
    return { state: "offline", account: null, vaults: [], detail: "No host bridge is configured" };
  }
  try {
    const res = await bridge(config, "/1password");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return OnePasswordStatus.parse(await res.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "offline",
      account: null,
      vaults: [],
      detail: `Host bridge unreachable: ${message}`,
    };
  }
}

export function readGrants(store: Store): Promise<OnePasswordGrants> {
  return store.getSetting(SETTING, (v) => OnePasswordGrants.parse(v), {});
}

/** Gives a nibblet exactly these vaults (none to take them all away). */
export async function setGrants(
  config: BridgeConfig,
  store: Store,
  nibblet: { id: string; name: string },
  grants: VaultGrant[],
): Promise<OnePasswordGrants> {
  const res = await bridge(config, `/1password/grants/${encodeURIComponent(nibblet.id)}`, {
    method: "PUT",
    body: JSON.stringify({ label: nibblet.name, grants }),
  });
  if (!res.ok) {
    const body = z.object({ error: z.string() }).safeParse(await res.json().catch(() => null));
    throw new RpcError("unavailable", body.success ? body.data.error : "Couldn't update 1Password");
  }
  const all = await readGrants(store);
  if (grants.length > 0) all[nibblet.id] = grants;
  else delete all[nibblet.id];
  await store.setSetting(SETTING, all);
  return all;
}

/** Forgets a deleted nibblet's vaults; quietly, since the nibblet is going anyway. */
export async function forgetGrants(config: BridgeConfig, store: Store, nibbletId: string) {
  const all = await readGrants(store);
  if (!all[nibbletId]) return;
  delete all[nibbletId];
  await store.setSetting(SETTING, all);
  if (config.HOST_MCP_URL) {
    await bridge(config, `/1password/grants/${encodeURIComponent(nibbletId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

const TokenResponse = z.object({ token: z.string(), vaults: z.array(SharedVault) });

/**
 * A nibblet's 1Password access: the service account token, for the guard's
 * 1Password tools (never the runner, which shares a user with the agent),
 * and the vault names, which aren't secret. Null when nothing is shared.
 */
export async function onePasswordLogin(
  config: BridgeConfig,
  store: Store,
  nibbletId: string,
  warn: (message: string) => void,
): Promise<{ token: string; vaults: SharedVault[] } | null> {
  if (!config.HOST_MCP_URL) return null;
  const grants = await readGrants(store);
  if (!grants[nibbletId]?.length) return null;
  try {
    const res = await bridge(config, `/1password/token/${encodeURIComponent(nibbletId)}`);
    if (!res.ok) {
      warn("1Password access isn't available; share the vaults again in Settings");
      return null;
    }
    return TokenResponse.parse(await res.json());
  } catch {
    warn("Couldn't reach the host bridge for 1Password");
    return null;
  }
}
