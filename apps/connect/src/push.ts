/**
 * Web Push from a Worker with nothing but WebCrypto: the message encrypted
 * for one browser (RFC 8291, aes128gcm) and the request signed with this
 * service's VAPID key (RFC 8292), so push services know who's sending.
 */

export interface PushTarget {
  endpoint: string;
  /** The browser's public key, base64url. */
  p256dh: string;
  /** The browser's auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** The private key as a JWK (with its x and y). */
  privateJwk: JsonWebKey;
  /** Who to contact about this sender: a mailto: or https: address. */
  subject: string;
}

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** The VAPID public key, as browsers want it for `applicationServerKey`. */
export function vapidPublicKey(privateJwk: JsonWebKey): string {
  if (!privateJwk.x || !privateJwk.y) throw new Error("The VAPID key has no public part");
  return base64url(
    concat(new Uint8Array([4]), fromBase64url(privateJwk.x), fromBase64url(privateJwk.y)),
  );
}

/** The body of one push message, encrypted for one browser. */
export async function encryptPayload(
  target: Pick<PushTarget, "p256dh" | "auth">,
  plaintext: Uint8Array<ArrayBuffer>,
  // Injectable so tests can use known values.
  random: { salt?: Uint8Array<ArrayBuffer>; keys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  const salt = random.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const local =
    random.keys ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  if (!("privateKey" in local)) throw new Error("Expected a key pair");
  const exported = await crypto.subtle.exportKey("raw", local.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
  const asPublic = new Uint8Array(exported);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // A variable rather than a literal: Workers' types spell the standard `public` as `$public`.
  const ecdh = { name: "ECDH", public: uaKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const ikm = await hkdf(
    authSecret,
    new Uint8Array(shared),
    concat(utf8("WebPush: info\0"), uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // One record: the message, then the 0x02 delimiter that marks the last one.
  const record = concat(plaintext, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/** The Authorization header for a push service: a short-lived JWT signed with the VAPID key. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = base64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    utf8(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`)),
  );
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${vapidPublicKey(vapid.privateJwk)}`;
}

export type PushResult = "sent" | "gone" | "failed";

/**
 * Sends one message to one browser. "gone" means the subscription is over
 * (unsubscribed, or the app removed) and should be forgotten.
 */
export async function sendPush(
  target: PushTarget,
  message: object,
  vapid: VapidKeys,
  options: { ttlSeconds?: number; urgency?: "normal" | "high"; fetch?: typeof fetch } = {},
): Promise<PushResult> {
  const body = await encryptPayload(target, utf8(JSON.stringify(message)));
  const res = await (options.fetch ?? fetch)(target.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorization(target.endpoint, vapid),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(options.ttlSeconds ?? 24 * 60 * 60),
      urgency: options.urgency ?? "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return "gone";
  return res.ok ? "sent" : "failed";
}
