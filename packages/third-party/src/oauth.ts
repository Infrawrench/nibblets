import { WebUrl } from "@nibblets/protocol";
import { z } from "zod";
import { ThirdPartyError } from "./errors.ts";

/*
 * Signing in on a third party's site: OAuth 2.1 as MCP servers do it, so a
 * third party with an MCP server usually has it already. Connect registers
 * itself as a public client (RFC 7591), sends the person to the authorize
 * page with PKCE, and swaps the code it gets back for their token. Shared
 * here so a plugin only says where its server is and what to ask for.
 */

/** Signing in on the third party's site. */
export interface ThirdPartySignIn {
  /** Where its authorization server's metadata is (`/.well-known/oauth-authorization-server`). */
  issuer: string;
  /** The resource the token is for (RFC 8707), when it wants one named. */
  resource: string | null;
  /** What to ask for. The person may allow less; `identify` says what they did. */
  scopes: readonly string[];
}

export interface ThirdPartyDeps {
  fetch: typeof globalThis.fetch;
}

const TIMEOUT_MS = 15_000;

/** RFC 8414 metadata, the parts used here. */
const Metadata = z
  .object({
    authorization_endpoint: WebUrl,
    token_endpoint: WebUrl,
    registration_endpoint: WebUrl.optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .loose();

export interface AuthServer {
  authorize: string;
  token: string;
  register: string | null;
}

const Registered = z.object({ client_id: z.string().min(1) }).loose();

const Token = z.object({ access_token: z.string().min(1), token_type: z.string() }).loose();

const OAuthError = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .loose();

/** What Connect tells the third party about itself when it registers. */
export interface ClientDetails {
  name: string;
  /** Its home page. */
  uri: string;
  redirectUri: string;
}

/** Reads a JSON reply, or says plainly that there wasn't one. */
async function json(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new Error(`${what} answered ${res.status} without JSON`);
  }
}

/** The OAuth error's words when there are some, for the person to read. */
function refusal(body: unknown, what: string): ThirdPartyError {
  const parsed = OAuthError.safeParse(body);
  const said = parsed.success
    ? (parsed.data.error_description ?? parsed.data.error)
    : "it said no without saying why";
  return new ThirdPartyError(`${what}: ${said}`);
}

export async function discover(issuer: string, deps: ThirdPartyDeps): Promise<AuthServer> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const res = await deps.fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const metadata = Metadata.parse(await json(res, url));
  const methods = metadata.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new ThirdPartyError("Its sign-in doesn't support PKCE, so it can't be used here");
  }
  return {
    authorize: metadata.authorization_endpoint,
    token: metadata.token_endpoint,
    register: metadata.registration_endpoint ?? null,
  };
}

/** Registers Connect as a public client for one redirect address; returns its client id. */
export async function registerClient(
  server: AuthServer,
  client: ClientDetails,
  scopes: readonly string[],
  deps: ThirdPartyDeps,
): Promise<string> {
  if (!server.register) {
    throw new ThirdPartyError(
      "Its sign-in doesn't let new apps register, so it can't be used here",
    );
  }
  const res = await deps.fetch(server.register, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: client.name,
      client_uri: client.uri,
      redirect_uris: [client.redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes.join(" "),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await json(res, server.register);
  if (res.status >= 400 && res.status < 500) throw refusal(body, "It wouldn't register Nibblets");
  if (!res.ok) throw new Error(`${server.register} answered ${res.status}`);
  return Registered.parse(body).client_id;
}

/** A PKCE verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: readonly string[];
  resource: string | null;
}

/** Where to send the person to sign in and choose what to allow. */
export function authorizeUrl(server: AuthServer, request: AuthorizeRequest): string {
  const url = new URL(server.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.scopes.length > 0) url.searchParams.set("scope", request.scopes.join(" "));
  if (request.resource) url.searchParams.set("resource", request.resource);
  return url.href;
}

export interface CodeExchange {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  resource: string | null;
}

/**
 * Swaps the code the person came back with for their token. A client the
 * third party no longer knows is a `StaleClientError`, so Connect can
 * register again.
 */
export async function exchangeCode(
  server: AuthServer,
  exchange: CodeExchange,
  deps: ThirdPartyDeps,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: exchange.code,
    redirect_uri: exchange.redirectUri,
    client_id: exchange.clientId,
    code_verifier: exchange.verifier,
  });
  if (exchange.resource) form.set("resource", exchange.resource);
  const res = await deps.fetch(server.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await json(res, server.token);
  if (res.status >= 400 && res.status < 500) {
    const parsed = OAuthError.safeParse(body);
    if (parsed.success && parsed.data.error === "invalid_client") throw new StaleClientError();
    throw refusal(body, "Signing in didn't finish");
  }
  if (!res.ok) throw new Error(`${server.token} answered ${res.status}`);
  return Token.parse(body).access_token;
}

/** The third party forgot the client Connect registered. */
export class StaleClientError extends ThirdPartyError {
  constructor() {
    super("It no longer knew Nibblets. Try connecting again.");
    this.name = "StaleClientError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
