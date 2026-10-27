/**
 * Sealing credentials Connect has to use rather than check (third parties'
 * tokens): AES-256-GCM under `THIRD_PARTY_KEY`, with what it belongs to
 * (a row's id) as additional data, so a sealed value copied onto another
 * row won't open there.
 */

const VERSION = "v1";

export class Vault {
  private readonly key: Promise<CryptoKey>;

  /** `secret` is 32 bytes in base64 (`openssl rand -base64 32`). */
  constructor(secret: string) {
    const raw = fromBase64(secret.trim());
    if (raw.byteLength !== 32) throw new Error("THIRD_PARTY_KEY must be 32 bytes in base64");
    this.key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  async seal(plaintext: string, belongsTo: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(belongsTo) },
      await this.key,
      new TextEncoder().encode(plaintext),
    );
    return [VERSION, toBase64(iv), toBase64(new Uint8Array(sealed))].join(".");
  }

  /** Throws when it's been tampered with, sealed for something else, or under another key. */
  async open(sealed: string, belongsTo: string): Promise<string> {
    const [version, iv, data] = sealed.split(".");
    if (version !== VERSION || !iv || !data) throw new Error("Not a sealed value");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: new TextEncoder().encode(belongsTo) },
      await this.key,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  }
}

/** A vault when the key is set, or null: third parties are off without one. */
export function vault(secret: string): Vault | null {
  return secret.trim() ? new Vault(secret) : null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
