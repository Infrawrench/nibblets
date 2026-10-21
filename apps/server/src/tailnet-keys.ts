import { createHash } from "node:crypto";
import { MASKED, RpcError, TailnetOAuth, type TailnetKeys } from "@nibblets/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";

/**
 * Keys for nibblets to join the tailnet with, made by the server with the
 * user's Tailscale OAuth client, so they don't have to paste one into each
 * nibblet. Only a key goes to the container (single use, an hour long): the
 * client's secret, which could make any number of them, stays here.
 */

const SETTING = "tailnetKeys";
const API = "https://api.tailscale.com/api/v2";

export function readTailnetOAuth(store: Store): Promise<TailnetOAuth | null> {
  return store.getSetting(SETTING, (v) => TailnetOAuth.parse(v), null);
}

/** What the API shows: the secret masked. */
export async function tailnetKeys(store: Store): Promise<TailnetKeys> {
  const oauth = await readTailnetOAuth(store);
  return { oauth: oauth && { ...oauth, clientSecret: MASKED } };
}

const Token = z.object({ access_token: z.string() });

async function failure(res: Response): Promise<string> {
  const body = z
    .object({ message: z.string().optional(), error_description: z.string().optional() })
    .safeParse(await res.json().catch(() => null));
  const said = body.success ? (body.data.message ?? body.data.error_description) : undefined;
  return said ? `Tailscale said: ${said}` : `Tailscale said ${res.status}`;
}

async function accessToken(oauth: TailnetOAuth, fetcher: typeof fetch): Promise<string> {
  const res = await fetcher(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new RpcError("bad_request", await failure(res));
  return Token.parse(await res.json()).access_token;
}

/** Saves the OAuth client once Tailscale takes it, or forgets it. */
export async function setTailnetKeys(
  store: Store,
  input: TailnetKeys,
  fetcher: typeof fetch = fetch,
): Promise<TailnetKeys> {
  if (!input.oauth) {
    await store.deleteSetting(SETTING);
    return { oauth: null };
  }
  const stored = await readTailnetOAuth(store);
  const oauth: TailnetOAuth = {
    ...input.oauth,
    clientSecret:
      input.oauth.clientSecret === MASKED ? (stored?.clientSecret ?? "") : input.oauth.clientSecret,
  };
  if (!oauth.clientSecret) throw new RpcError("bad_request", "Paste the client's secret");
  await accessToken(oauth, fetcher);
  await store.setSetting(SETTING, oauth);
  return tailnetKeys(store);
}

/** Tailscale takes key descriptions of up to 50 letters, digits, spaces and hyphens. */
export function keyDescription(name: string): string {
  return `nibblet ${name}`
    .replace(/[^A-Za-z0-9 -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50)
    .trim();
}

/** A single-use, pre-approved, tagged key that lasts an hour, for one nibblet to join with. */
export async function mintAuthKey(
  oauth: TailnetOAuth,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const token = await accessToken(oauth, fetcher);
  const res = await fetcher(`${API}/tailnet/-/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: { reusable: false, ephemeral: false, preauthorized: true, tags: oauth.tags },
        },
      },
      expirySeconds: 3600,
      description: keyDescription(name),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new RpcError("unavailable", await failure(res));
  return z.object({ key: z.string() }).parse(await res.json()).key;
}

/**
 * Stands for where a nibblet's key comes from. Its own key's hash is what
 * containers already marked themselves with before there were OAuth clients.
 */
export function keyId(ownKey: string, oauth: TailnetOAuth | null): string | null {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  if (ownKey) return sha(ownKey);
  return oauth ? sha(`oauth:${oauth.clientId}`) : null;
}
