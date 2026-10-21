import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The key a nibblet's container presents to the credential proxy: the id of
 * the nibblet its API usage bills to, signed with the proxy's shared secret.
 * The proxy can tell whose it is without asking anyone, and an agent that
 * reads its own can't make one for another nibblet, so what it spends on an
 * API key counts against its own budget.
 *
 * Node only, so it's `@nibblets/protocol/proxy-key` rather than in the index
 * the web UI imports.
 */
export function nibbletProxyKey(secret: string, nibbletId: string): string {
  return `${nibbletId}.${sign(secret, nibbletId)}`;
}

/** The nibblet a key was made for, or null if it isn't one made with `secret`. */
export function proxyKeyOwner(secret: string, key: string): string | null {
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return null;
  const nibbletId = key.slice(0, dot);
  const given = Buffer.from(key.slice(dot + 1));
  const want = Buffer.from(sign(secret, nibbletId));
  return given.length === want.length && timingSafeEqual(given, want) ? nibbletId : null;
}

function sign(secret: string, nibbletId: string): string {
  return createHmac("sha256", secret).update(`credproxy:${nibbletId}`).digest("base64url");
}
