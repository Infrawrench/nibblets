import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  pkce,
  registerClient,
  renewGrant,
  StaleClientError,
  ThirdPartyError,
  ThirdPartyRevokedError,
  type AuthServer,
} from "./index.ts";

const ISSUER = "https://agent.example";

const server: AuthServer = {
  authorize: `${ISSUER}/oauth/authorize`,
  token: `${ISSUER}/oauth/token`,
  register: `${ISSUER}/oauth/register`,
};

/** One canned reply per request, keeping what was asked. */
function answering(reply: (request: Request, body: string) => Response) {
  const requests: { url: string; body: string; type: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    requests.push({ url: request.url, body, type: request.headers.get("content-type") });
    return reply(request, body);
  };
  return { fetch, requests };
}

describe("signing in on a third party's site", () => {
  it("reads the authorization server's metadata", async () => {
    const http = answering(() =>
      Response.json({
        issuer: ISSUER,
        authorization_endpoint: server.authorize,
        token_endpoint: server.token,
        registration_endpoint: server.register,
        code_challenge_methods_supported: ["S256"],
      }),
    );
    expect(await discover(`${ISSUER}/`, http)).toEqual(server);
    expect(http.requests[0]?.url).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  it("won't use a server without PKCE, or one whose endpoints aren't web addresses", async () => {
    const plain = answering(() =>
      Response.json({
        authorization_endpoint: server.authorize,
        token_endpoint: server.token,
        code_challenge_methods_supported: ["plain"],
      }),
    );
    await expect(discover(ISSUER, plain)).rejects.toThrow(ThirdPartyError);
    const sneaky = answering(() =>
      Response.json({
        authorization_endpoint: "javascript:alert(1)",
        token_endpoint: server.token,
      }),
    );
    await expect(discover(ISSUER, sneaky)).rejects.toThrow();
  });

  it("registers as a public client for one redirect address", async () => {
    const http = answering(() => Response.json({ client_id: "c_1" }, { status: 201 }));
    const id = await registerClient(
      server,
      {
        name: "Nibblets",
        uri: "https://app.nibblets.dev",
        redirectUri: "https://app.nibblets.dev/cb",
      },
      ["a:read", "b:write"],
      http,
    );
    expect(id).toBe("c_1");
    expect(JSON.parse(http.requests[0]?.body ?? "")).toEqual({
      client_name: "Nibblets",
      client_uri: "https://app.nibblets.dev",
      redirect_uris: ["https://app.nibblets.dev/cb"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "a:read b:write",
    });
  });

  it("registers to renew tokens too when it asks for offline access", async () => {
    const http = answering(() => Response.json({ client_id: "c_1" }, { status: 201 }));
    await registerClient(
      server,
      { name: "N", uri: "https://x.test", redirectUri: "https://x.test/cb" },
      ["openid", "offline_access"],
      http,
    );
    expect(JSON.parse(http.requests[0]?.body ?? "")).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("says why registering was refused, in the server's words", async () => {
    const http = answering(() =>
      Response.json(
        { error: "invalid_redirect_uri", error_description: "That address isn't allowed" },
        { status: 400 },
      ),
    );
    await expect(
      registerClient(
        server,
        { name: "N", uri: "https://x.test", redirectUri: "https://x.test/cb" },
        [],
        http,
      ),
    ).rejects.toThrow("It wouldn't register Nibblets: That address isn't allowed");
  });

  it("sends the person to sign in with an S256 challenge of the verifier", async () => {
    const { verifier, challenge } = await pkce();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(challenge).toBe(Buffer.from(digest).toString("base64url"));
    const url = new URL(
      authorizeUrl(server, {
        clientId: "c_1",
        redirectUri: "https://app.nibblets.dev/cb",
        state: "s_1",
        challenge,
        scopes: ["a:read", "b:write"],
        resource: `${ISSUER}/mcp`,
      }),
    );
    expect(url.origin + url.pathname).toBe(server.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "c_1",
      redirect_uri: "https://app.nibblets.dev/cb",
      state: "s_1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "a:read b:write",
      resource: `${ISSUER}/mcp`,
    });
  });

  it("swaps the code for a token with the verifier", async () => {
    const http = answering(() => Response.json({ access_token: "tok", token_type: "Bearer" }));
    const got = await exchangeCode(
      server,
      {
        clientId: "c_1",
        redirectUri: "https://x.test/cb",
        code: "code",
        verifier: "v",
        resource: null,
      },
      http,
    );
    expect(got).toEqual({ access: "tok", refresh: null, expiresAt: null });
    expect(http.requests[0]?.type).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(http.requests[0]?.body))).toEqual({
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://x.test/cb",
      client_id: "c_1",
      code_verifier: "v",
    });
  });

  it("tells a forgotten client from any other refusal", async () => {
    const exchange = {
      clientId: "c",
      redirectUri: "https://x.test/cb",
      code: "c",
      verifier: "v",
      resource: null,
    };
    const forgot = answering(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    await expect(exchangeCode(server, exchange, forgot)).rejects.toThrow(StaleClientError);
    const used = answering(() =>
      Response.json(
        { error: "invalid_grant", error_description: "Code already used" },
        { status: 400 },
      ),
    );
    await expect(exchangeCode(server, exchange, used)).rejects.toThrow(
      "Signing in didn't finish: Code already used",
    );
  });
});

describe("renewing a sign-in that runs out", () => {
  const renewal = { clientId: "c_1", refresh: "r_1", resource: "https://api.x.test" };

  it("swaps the refresh token for a new pair, and says when the new one runs out", async () => {
    const http = answering(() =>
      Response.json({
        access_token: "tok_2",
        token_type: "Bearer",
        refresh_token: "r_2",
        expires_in: 300,
      }),
    );
    const before = Date.now();
    const got = await renewGrant(server, renewal, http);
    expect(got.access).toBe("tok_2");
    expect(got.refresh).toBe("r_2");
    expect(got.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(Object.fromEntries(new URLSearchParams(http.requests[0]?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r_1",
      client_id: "c_1",
      resource: "https://api.x.test",
    });
  });

  it("keeps the old refresh token when the server doesn't send a new one", async () => {
    const http = answering(() => Response.json({ access_token: "tok_2", token_type: "Bearer" }));
    expect((await renewGrant(server, renewal, http)).refresh).toBe("r_1");
  });

  it("calls a refresh token it won't take any more revoked", async () => {
    const http = answering(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(renewGrant(server, renewal, http)).rejects.toThrow(ThirdPartyRevokedError);
  });
});
