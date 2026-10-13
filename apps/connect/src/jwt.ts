import { z } from "zod";

/**
 * ES256 tokens for servers, signed with Web Crypto. Servers verify them with
 * the public half from `/.well-known/jwks.json`, so the central service never
 * shares a secret with them.
 */

const PrivateJwk = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string(),
  y: z.string(),
  d: z.string(),
  kid: z.string(),
});
type PrivateJwk = z.infer<typeof PrivateJwk>;

export interface SigningKey {
  kid: string;
  key: CryptoKey;
  publicJwk: {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
    kid: string;
    alg: "ES256";
    use: "sig";
  };
}

export async function loadSigningKey(secret: string): Promise<SigningKey> {
  const jwk: PrivateJwk = PrivateJwk.parse(JSON.parse(secret));
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return {
    kid: jwk.kid,
    key,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      kid: jwk.kid,
      alg: "ES256",
      use: "sig",
    },
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Signs `claims` as a compact JWS. ECDSA in Web Crypto already gives JWS's r||s form. */
export async function signJwt(
  key: SigningKey,
  claims: Record<string, string | number>,
): Promise<string> {
  const head = `${encode({ alg: "ES256", typ: "JWT", kid: key.kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.key,
    new TextEncoder().encode(head),
  );
  return `${head}.${base64url(new Uint8Array(signature))}`;
}

export const TOKEN_TTL_SECONDS = 5 * 60;

/** A token for one server, for the person signed in to the central service. */
export async function serverToken(
  key: SigningKey,
  opts: { issuer: string; serverId: string; userId: string; name: string; now?: number },
): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const token = await signJwt(key, {
    iss: opts.issuer,
    aud: opts.serverId,
    sub: opts.userId,
    name: opts.name,
    iat: now,
    exp,
  });
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}
