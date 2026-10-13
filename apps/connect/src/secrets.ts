/** Random values and hashing for codes, poll tokens and server secrets. */

/** No 0/O, 1/I/L: the code is read off one screen and checked against another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function linkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length] ?? "A");
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(9)}`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two hex digests without leaking where they differ. Workers have
 * `crypto.subtle.timingSafeEqual`; the loop is for Node, where tests run.
 */
export function sameDigest(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  const subtle: SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean } =
    crypto.subtle;
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
