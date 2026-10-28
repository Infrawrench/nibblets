import { WebUrl } from "@nibblets/protocol";
import { z } from "zod";

/*
 * Signing in to another app as an OAuth 2.1 client, the way MCP servers
 * have it: register as a public client (RFC 7591), send the person to the
 * authorize page with PKCE, and swap the code they come back with for a
 * token. Asking for `offline_access` gets a refresh token too, for apps
 * whose tokens expire. Connect signs in to third parties with it, and the
 * server links apps with it, so neither knows OAuth itself.
 */

export interface OAuthDeps {
  fetch: typeof globalThis.fetch;
}

const TIMEOUT_MS = 15_000;

/** Its message is safe to show the person: what the app said, or why it can't be used. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

/** The app won't renew the sign-in any more: the person has to sign in again. */
export class SignInRevokedError extends SignInError {
  constructor(message: string) {
    super(message);
    this.name = "SignInRevokedError";
  }
}

/** The app forgot the client registered with it, so registering again may help. */
export class StaleClientError extends SignInError {
  constructor() {
    super("It no longer knew Nibblets. Try connecting again.");
    this.name = "StaleClientError";
  }
}

/** RFC 8414 metadata, the parts used here. */
const Metadata = z
  .object({
    issuer: z.string().optional(),
    authorization_endpoint: WebUrl,
    token_endpoint: WebUrl,
    registration_endpoint: WebUrl.optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
  })
  .loose();

export interface AuthServer {
  authorize: string;
  token: string;
  register: string | null;
  /**
   * The issuer the app names when it sends the person back (RFC 9207), to
   * check against; null when it doesn't.
   */
  issuer: string | null;
}

const Registered = z.object({ client_id: z.string().min(1) }).loose();

const Token = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string(),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().nonnegative().optional(),
    scope: z.string().optional(),
  })
  .loose();

/** What signing in or renewing gave. */
export interface Grant {
  access: string;
  /** Null when it gave none, so the access token is all there is. */
  refresh: string | null;
  /** When the access token stops working, in epoch milliseconds; null when it didn't say. */
  expiresAt: number | null;
  /** What the person allowed, when the app said; null when it didn't. */
  scopes: string[] | null;
}

function grant(body: unknown, refresh: string | null): Grant {
  const token = Token.parse(body);
  return {
    access: token.access_token,
    // Some servers renew without a new refresh token, and the old one carries on.
    refresh: token.refresh_token ?? refresh,
    expiresAt: token.expires_in !== undefined ? Date.now() + token.expires_in * 1000 : null,
    scopes: token.scope !== undefined ? token.scope.split(" ").filter(Boolean) : null,
  };
}

const OAuthError = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .loose();

/** What the client tells the app about itself when it registers. */
export interface ClientDetails {
  name: string;
  /** Its home page; left out when there's none to give. */
  uri: string | null;
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
function refusal(body: unknown, what: string): SignInError {
  const parsed = OAuthError.safeParse(body);
  const said = parsed.success
    ? (parsed.data.error_description ?? parsed.data.error)
    : "it said no without saying why";
  return new SignInError(`${what}: ${said}`);
}

/** Reads an authorization server's metadata, from its issuer. */
export async function discover(issuer: string, deps: OAuthDeps): Promise<AuthServer> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
  const res = await deps.fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const metadata = Metadata.parse(await json(res, url));
  const methods = metadata.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new SignInError("Its sign-in doesn't support PKCE, so it can't be used here");
  }
  return {
    authorize: metadata.authorization_endpoint,
    token: metadata.token_endpoint,
    register: metadata.registration_endpoint ?? null,
    issuer: metadata.authorization_response_iss_parameter_supported
      ? (metadata.issuer ?? null)
      : null,
  };
}

/** Registers as a public client for one redirect address; returns its client id. */
export async function registerClient(
  server: AuthServer,
  client: ClientDetails,
  scopes: readonly string[],
  deps: OAuthDeps,
): Promise<string> {
  if (!server.register) {
    throw new SignInError("Its sign-in doesn't let new apps register, so it can't be used here");
  }
  const res = await deps.fetch(server.register, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: client.name,
      ...(client.uri ? { client_uri: client.uri } : {}),
      redirect_uris: [client.redirectUri],
      grant_types: scopes.includes("offline_access")
        ? ["authorization_code", "refresh_token"]
        : ["authorization_code"],
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

/** A random value for `state`, which says the person came back from this sign-in. */
export function randomState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
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

/** How the person came back from the authorize page. */
export type Return =
  | { status: "code"; code: string }
  /** They turned it down. */
  | { status: "denied" }
  | { status: "failed"; message: string };

/**
 * Reads where the authorize page sent the person back to: its code, or why
 * there's none. Only call it once `state` has been matched to a sign-in.
 * An issuer that doesn't match the one signed in with (RFC 9207) is a
 * mix-up, and fails.
 */
export function readReturn(server: AuthServer, query: URLSearchParams): Return {
  const iss = query.get("iss");
  if (server.issuer !== null && iss !== server.issuer) {
    return { status: "failed", message: "The sign-in came back from somewhere else" };
  }
  const error = query.get("error");
  if (error === "access_denied") return { status: "denied" };
  if (error) {
    return { status: "failed", message: query.get("error_description") ?? error };
  }
  const code = query.get("code");
  return code
    ? { status: "code", code }
    : { status: "failed", message: "The sign-in came back without a code" };
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
 * app no longer knows is a `StaleClientError`, so it can be registered again.
 */
export async function exchangeCode(
  server: AuthServer,
  exchange: CodeExchange,
  deps: OAuthDeps,
): Promise<Grant> {
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
  return grant(body, null);
}

export interface Renewal {
  clientId: string;
  refresh: string;
  resource: string | null;
}

/**
 * Swaps a refresh token for a new access token (and usually a new refresh
 * token). One it won't take any more is a `SignInRevokedError`: the person
 * has to sign in again.
 */
export async function renewGrant(
  server: AuthServer,
  renewal: Renewal,
  deps: OAuthDeps,
): Promise<Grant> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: renewal.refresh,
    client_id: renewal.clientId,
  });
  if (renewal.resource) form.set("resource", renewal.resource);
  const res = await deps.fetch(server.token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await json(res, server.token);
  if (res.status >= 400 && res.status < 500) {
    const parsed = OAuthError.safeParse(body);
    if (parsed.success && ["invalid_grant", "invalid_client"].includes(parsed.data.error)) {
      throw new SignInRevokedError("Signing in has run out. Connect it again in Settings.");
    }
    throw refusal(body, "Renewing its sign-in didn't work");
  }
  if (!res.ok) throw new Error(`${server.token} answered ${res.status}`);
  return grant(body, renewal.refresh);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
