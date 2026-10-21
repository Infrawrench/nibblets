import { timingSafeEqual } from "node:crypto";

/** Compares secrets without leaking, through timing, how much of one matched. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The token in an `Authorization: Bearer` header, or empty. */
export function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}
