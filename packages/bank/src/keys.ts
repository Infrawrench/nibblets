import { createHmac } from "node:crypto";

/** The order of secp256k1, which Bitcoin and Ethereum keys share. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A card wallet's private key, derived from the treasury's secret and the
 * card's id, so the server never stores one: it can make the key again to
 * write the card's file, or to sweep the wallet when the card is killed.
 * `chain` keeps Bitcoin's and Ethereum's keys apart if they share a secret.
 */
export function deriveWalletKey(secret: Uint8Array, chain: string, cardId: string): Uint8Array {
  if (secret.length < 32) throw new Error("A treasury secret needs at least 32 bytes");
  for (let counter = 0; ; counter++) {
    const key = createHmac("sha256", secret)
      .update(`nibblet-card/${chain}/${cardId}/${counter}`)
      .digest();
    const n = BigInt(`0x${key.toString("hex")}`);
    // Out of range about once in 2^128 tries; take the next one if so.
    if (n > 0n && n < SECP256K1_N) return new Uint8Array(key);
  }
}

/** `0x`-optional hex into bytes; throws on anything that isn't. */
export function hexBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) throw new Error("Not hex");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

export function bytesHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
