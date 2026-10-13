import { z } from "zod";
import { storage } from "./storage.ts";

const TOKEN_KEY = "nibblet.token";
const PairResponse = z.object({ token: z.string() });

export function loadToken(): string | null {
  return storage.get(TOKEN_KEY);
}

export function forgetToken(): void {
  storage.remove(TOKEN_KEY);
}

/**
 * Signs in from a pairing link (`#pair=<code>`), if this page was opened from
 * one. The code is one-time, so the hash is cleared whatever happens.
 */
export async function redeemPairingLink(): Promise<"paired" | "none" | "failed"> {
  const match = /(?:^#|&)pair=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return "none";
  const code = decodeURIComponent(match[1]);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return "failed";
    const { token } = PairResponse.parse(await res.json());
    storage.set(TOKEN_KEY, token);
    return "paired";
  } catch {
    return "failed";
  }
}

/**
 * `?mock` runs the UI against an in-memory server. It sticks for the tab,
 * since in-app links don't carry the query string; `?mock=0` turns it off.
 */
export function isMockMode(): boolean {
  const param = new URLSearchParams(window.location.search).get("mock");
  try {
    if (param === "0") sessionStorage.removeItem("nibblet.mock");
    else if (param !== null) sessionStorage.setItem("nibblet.mock", "1");
    return sessionStorage.getItem("nibblet.mock") === "1";
  } catch {
    return param !== null && param !== "0";
  }
}
