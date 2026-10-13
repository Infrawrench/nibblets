// Prints a fresh ES256 private key as a JWK, for the JWT_PRIVATE_KEY secret:
//   node scripts/gen-key.mjs | npx wrangler secret put JWT_PRIVATE_KEY
// Servers trust tokens signed with it through /.well-known/jwks.json, so
// replacing it signs everyone out of every server until they reload.
const { privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const kid = crypto.randomUUID();
process.stdout.write(JSON.stringify({ ...jwk, kid, alg: "ES256", use: "sig" }));
