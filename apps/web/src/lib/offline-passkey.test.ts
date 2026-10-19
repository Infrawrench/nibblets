import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPasskey,
  decode,
  encode,
  getPasskey,
  passkeyWrappingKey,
  randomBytes,
} from "./offline-passkey.ts";
import type { PasskeyMetadata } from "./offline-passkey.ts";

const origin = "https://offline.example";
const credentialId = new Uint8Array([1, 2, 3]);
const secret = new Uint8Array(32).fill(42);

class Attestation {
  constructor(
    readonly clientDataJSON: ArrayBuffer,
    private readonly data: ArrayBuffer,
  ) {}
  getAuthenticatorData(): ArrayBuffer {
    return this.data;
  }
}
class Assertion {
  constructor(
    readonly clientDataJSON: ArrayBuffer,
    readonly authenticatorData: ArrayBuffer,
  ) {}
}
class Credential {
  readonly type = "public-key";
  readonly rawId = credentialId.buffer;
  readonly id = "AQID";
  constructor(
    readonly response: Attestation | Assertion,
    private readonly extensions: object,
  ) {}
  getClientExtensionResults(): object {
    return this.extensions;
  }
}

async function response(
  challenge: BufferSource,
  type: string,
  extensions: object,
  flags = 5,
  requestedOrigin = origin,
  tamper?: "rpHash" | "crossOrigin",
): Promise<Credential> {
  const data = new Uint8Array(37);
  data.set(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("offline.example")),
    ),
  );
  data[32] = flags;
  if (tamper === "rpHash") data[0] = data[0]! ^ 1;
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type,
      origin: requestedOrigin,
      crossOrigin: tamper === "crossOrigin",
      challenge: encode(new Uint8Array(challenge as ArrayBuffer))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    }),
  ).buffer;
  return new Credential(
    type === "webauthn.create"
      ? new Attestation(clientDataJSON, data.buffer)
      : new Assertion(clientDataJSON, data.buffer),
    extensions,
  );
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: "offline.example" });
  vi.stubGlobal("PublicKeyCredential", Credential);
  vi.stubGlobal("AuthenticatorAttestationResponse", Attestation);
  vi.stubGlobal("AuthenticatorAssertionResponse", Assertion);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("passkey encryption wrapper", () => {
  it("performs a restricted get when registration supports PRF without returning a result", async () => {
    const get = vi.fn(async (options: CredentialRequestOptions) =>
      response(options.publicKey!.challenge, "webauthn.get", {
        prf: { results: { first: secret.slice().buffer } },
      }),
    );
    const create = vi.fn(async (options: CredentialCreationOptions) =>
      response(options.publicKey!.challenge, "webauthn.create", { prf: { enabled: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { get, create } });
    const created = await createPasskey(encode(randomBytes(32)));
    expect(created.secret).toEqual(secret);
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0].publicKey!.allowCredentials).toEqual([
      { id: credentialId, type: "public-key" },
    ]);
    expect(create.mock.calls[0]![0].publicKey!.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "required",
    });
    expect(get.mock.calls[0]![0].publicKey!.userVerification).toBe("required");
    const originalSecret = created.secret;
    const key = await passkeyWrappingKey(originalSecret, created.metadata, "scope");
    expect(originalSecret.every((byte) => byte === 0)).toBe(true);
    expect(key.extractable).toBe(false);
    const iv = randomBytes(12);
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, secret);
    const restored = await passkeyWrappingKey(
      await getPasskey(created.metadata),
      created.metadata,
      "scope",
    );
    expect(
      new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, restored, wrapped)),
    ).toEqual(secret);
    const otherScope = await passkeyWrappingKey(secret.slice(), created.metadata, "another-scope");
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, otherScope, wrapped),
    ).rejects.toThrow();
  });

  it.each([
    ["missing UV", 1, origin, 32],
    ["missing UP", 4, origin, 32],
    ["wrong origin", 5, "https://attacker.example", 32],
    ["short PRF", 5, origin, 31],
  ])(
    "rejects %s before using the encryption secret",
    async (_name, flags, requestedOrigin, size) => {
      const metadata: PasskeyMetadata = {
        credential: encode(credentialId),
        input: encode(randomBytes(32)),
        salt: encode(randomBytes(32)),
      };
      vi.stubGlobal("navigator", {
        credentials: {
          get: async (options: CredentialRequestOptions) =>
            response(
              options.publicKey!.challenge,
              "webauthn.get",
              { prf: { results: { first: new Uint8Array(size).buffer } } },
              flags,
              requestedOrigin,
            ),
        },
      });
      await expect(getPasskey(metadata)).rejects.toThrow();
    },
  );

  it.each(["challenge", "rpHash", "crossOrigin"] as const)(
    "rejects a substituted %s",
    async (tamper) => {
      const metadata = {
        credential: encode(credentialId),
        input: encode(randomBytes(32)),
        salt: encode(randomBytes(32)),
      };
      vi.stubGlobal("navigator", {
        credentials: {
          get: async (options: CredentialRequestOptions) =>
            response(
              tamper === "challenge" ? randomBytes(32) : options.publicKey!.challenge,
              "webauthn.get",
              { prf: { results: { first: secret.slice().buffer } } },
              5,
              origin,
              tamper === "challenge" ? undefined : tamper,
            ),
        },
      });
      await expect(getPasskey(metadata)).rejects.toThrow();
    },
  );

  it("rejects cancellation, unsupported PRF, and a substituted credential", async () => {
    const metadata = {
      credential: encode(new Uint8Array([4])),
      input: encode(randomBytes(32)),
      salt: encode(randomBytes(32)),
    };
    vi.stubGlobal("navigator", { credentials: { get: async () => null } });
    await expect(getPasskey(metadata)).rejects.toThrow("cancelled");
    vi.stubGlobal("navigator", {
      credentials: {
        get: async (options: CredentialRequestOptions) =>
          response(options.publicKey!.challenge, "webauthn.get", {
            prf: { results: { first: secret.slice().buffer } },
          }),
      },
    });
    await expect(getPasskey(metadata)).rejects.toThrow("Unexpected");
    vi.stubGlobal("navigator", {
      credentials: {
        create: async (options: CredentialCreationOptions) =>
          response(options.publicKey!.challenge, "webauthn.create", {}),
      },
    });
    await expect(createPasskey(encode(randomBytes(32)))).rejects.toThrow("does not support");
  });

  it("round trips ciphertext larger than the JavaScript argument limit", () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    const decoded = decode(encode(bytes));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true);
  });
});
