type PrfExtensions = AuthenticationExtensionsClientOutputs & {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

export interface PasskeyMetadata {
  credential: string;
  input: string;
  salt: string;
}

export function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

export function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(size));
}

function requirePasskeys(): void {
  if (!isSecureContext || !navigator.credentials || !globalThis.PublicKeyCredential)
    throw new Error("Passkey unlock requires a supported secure browser.");
}

async function validate(
  credential: PublicKeyCredential,
  challenge: Uint8Array<ArrayBuffer>,
  type: "webauthn.create" | "webauthn.get",
  expectedId?: string,
): Promise<void> {
  const credentialId = encode(new Uint8Array(credential.rawId));
  if (
    credential.type !== "public-key" ||
    !credential.rawId.byteLength ||
    credential.rawId.byteLength > 1023 ||
    credential.id !== credentialId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") ||
    (expectedId && encode(new Uint8Array(credential.rawId)) !== expectedId)
  )
    throw new Error("Unexpected passkey credential.");
  const client: unknown = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
  const expectedChallenge = encode(challenge)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (
    !client ||
    typeof client !== "object" ||
    !("type" in client) ||
    client.type !== type ||
    !("challenge" in client) ||
    client.challenge !== expectedChallenge ||
    !("origin" in client) ||
    client.origin !== location.origin ||
    ("crossOrigin" in client && client.crossOrigin !== false)
  )
    throw new Error("Passkey client data failed verification.");
  const response = credential.response;
  const auth =
    response instanceof AuthenticatorAttestationResponse
      ? response.getAuthenticatorData()
      : (response as AuthenticatorAssertionResponse).authenticatorData;
  const data = new Uint8Array(auth);
  const rpHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(location.hostname)),
  );
  if (
    data.length < 37 ||
    !rpHash.every((byte, index) => byte === data[index]) ||
    (data[32]! & 0x05) !== 0x05
  )
    throw new Error("Passkey requires verified user presence for this site.");
}

function result(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> {
  const first = (credential.getClientExtensionResults() as PrfExtensions).prf?.results?.first;
  if (!(first instanceof ArrayBuffer) || first.byteLength !== 32)
    throw new Error("This passkey does not support encryption unlock. Use your passphrase.");
  return new Uint8Array(first);
}

export async function getPasskey(metadata: PasskeyMetadata): Promise<Uint8Array<ArrayBuffer>> {
  requirePasskeys();
  if (
    decode(metadata.input).length !== 32 ||
    decode(metadata.salt).length !== 32 ||
    !decode(metadata.credential).length ||
    decode(metadata.credential).length > 1023
  )
    throw new Error("Invalid passkey encryption metadata.");
  const challenge = randomBytes(32);
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: [{ id: decode(metadata.credential), type: "public-key" }],
      extensions: {
        prf: { eval: { first: decode(metadata.input) } },
      } as AuthenticationExtensionsClientInputs,
    },
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey unlock was cancelled.");
  await validate(credential, challenge, "webauthn.get", metadata.credential);
  return result(credential);
}

export async function createPasskey(
  vaultId: string,
): Promise<{ metadata: PasskeyMetadata; secret: Uint8Array<ArrayBuffer> }> {
  requirePasskeys();
  const challenge = randomBytes(32);
  const input = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: location.hostname, name: "Nibblets offline vault" },
      user: { id: decode(vaultId), name: "Offline vault", displayName: "Offline vault" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      extensions: { prf: { eval: { first: input } } } as AuthenticationExtensionsClientInputs,
    },
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey registration was cancelled.");
  await validate(credential, challenge, "webauthn.create");
  const metadata = {
    credential: encode(new Uint8Array(credential.rawId)),
    input: encode(input),
    salt: encode(randomBytes(32)),
  };
  const prf = (credential.getClientExtensionResults() as PrfExtensions).prf;
  if (prf?.enabled !== true)
    throw new Error("This passkey does not support encryption unlock. Use your passphrase.");
  return { metadata, secret: prf.results?.first ? result(credential) : await getPasskey(metadata) };
}

export async function passkeyWrappingKey(
  secret: Uint8Array<ArrayBuffer>,
  metadata: PasskeyMetadata,
  scope: string,
): Promise<CryptoKey> {
  try {
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: decode(metadata.salt),
        info: new TextEncoder().encode(
          JSON.stringify(["nibblets-offline-v1-passkey", location.origin, scope]),
        ),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    secret.fill(0);
  }
}
