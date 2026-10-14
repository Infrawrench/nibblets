import { describe, expect, it } from "vitest";
import {
  base64url,
  encryptPayload,
  fromBase64url,
  sendPush,
  vapidAuthorization,
  vapidPublicKey,
} from "../src/push.ts";

/*
 * Plays the browser's part: decrypts what was sent the way RFC 8291 says a
 * user agent does, and checks the VAPID signature against the public key.
 */

const encoder = new TextEncoder();

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string | Uint8Array<ArrayBuffer>,
  length: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? encoder.encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
      key,
      length * 8,
    ),
  );
}

async function browser() {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { keys, publicRaw, auth, p256dh: base64url(publicRaw), authText: base64url(auth) };
}

async function decrypt(ua: Awaited<ReturnType<typeof browser>>, body: Uint8Array<ArrayBuffer>) {
  const salt = body.slice(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idLength);
  const sealed = body.slice(21 + idLength);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.keys.privateKey, 256),
  );
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...ua.publicRaw, ...asPublic]);
  const ikm = await hkdf(ua.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed),
  );
  expect(record[record.length - 1]).toBe(2);
  return new TextDecoder().decode(record.slice(0, -1));
}

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    pair,
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    subject: "mailto:test@nibblets.dev",
  };
}

describe("web push", () => {
  it("encrypts so only that browser can read it", async () => {
    const ua = await browser();
    const body = await encryptPayload(
      { p256dh: ua.p256dh, auth: ua.authText },
      encoder.encode('{"title":"Crumpet needs your OK"}'),
    );
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(ua, body)).toBe('{"title":"Crumpet needs your OK"}');
  });

  it("signs for the push service with the VAPID key", async () => {
    const vapid = await vapidKeys();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    if (!match) throw new Error(`unexpected header ${header}`);
    const [, h, c, sig, k] = match;
    expect(k).toBe(vapidPublicKey(vapid.privateJwk));
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(c ?? "")))).toMatchObject({
      aud: "https://fcm.googleapis.com",
      sub: "mailto:test@nibblets.dev",
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      fromBase64url(k ?? ""),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64url(sig ?? ""),
      encoder.encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });

  it("tells a finished subscription from a failed send", async () => {
    const ua = await browser();
    const vapid = await vapidKeys();
    const target = { endpoint: "https://push.example/sub/1", p256dh: ua.p256dh, auth: ua.authText };
    const replying =
      (status: number): typeof fetch =>
      async () =>
        new Response(null, { status });
    expect(await sendPush(target, { title: "x" }, vapid, { fetch: replying(201) })).toBe("sent");
    expect(await sendPush(target, { title: "x" }, vapid, { fetch: replying(410) })).toBe("gone");
    expect(await sendPush(target, { title: "x" }, vapid, { fetch: replying(500) })).toBe("failed");
  });
});
