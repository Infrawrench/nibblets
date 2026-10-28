import {
  discover as discoverServer,
  exchangeCode as exchange,
  registerClient as register,
  renewGrant as renew,
  SignInError,
  SignInRevokedError,
  StaleClientError as StaleClient,
  type AuthServer,
  type ClientDetails,
  type CodeExchange,
  type Grant,
  type Renewal,
} from "@nibblets/oauth";
import { ThirdPartyError, ThirdPartyRevokedError } from "./errors.ts";

/*
 * Signing in on a third party's site: OAuth 2.1 as MCP servers do it, so a
 * third party with an MCP server usually has it already. The OAuth itself
 * is `@nibblets/oauth`'s; these say it in third parties' errors, so Connect
 * shows what a third party said and marks a sign-in that's run out revoked.
 * A plugin only says where its server is and what to ask for.
 */

export {
  authorizeUrl,
  pkce,
  type AuthorizeRequest,
  type AuthServer,
  type ClientDetails,
  type CodeExchange,
  type Grant,
  type Renewal,
} from "@nibblets/oauth";

/** Signing in on the third party's site. */
export interface ThirdPartySignIn {
  /** Where its authorization server's metadata is (`/.well-known/oauth-authorization-server`). */
  issuer: string;
  /** The resource the token is for (RFC 8707), when it wants one named. */
  resource: string | null;
  /**
   * What to ask for. The person may allow less; `identify` says what they
   * did. `offline_access` asks for a refresh token as well.
   */
  scopes: readonly string[];
}

export interface ThirdPartyDeps {
  fetch: typeof globalThis.fetch;
  /**
   * Keeps work going after the answer to the person has gone, such as
   * reading a reply streamed back that the third party stops writing if
   * nobody reads it. Without it, that work is dropped.
   */
  waitUntil?: (work: Promise<void>) => void;
}

/** The third party forgot the client Connect registered. */
export class StaleClientError extends ThirdPartyError {
  constructor() {
    super("It no longer knew Nibblets. Try connecting again.");
    this.name = "StaleClientError";
  }
}

/** Runs an OAuth step, saying what went wrong as a third party's error. */
async function asThirdParty<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StaleClient) throw new StaleClientError();
    if (err instanceof SignInRevokedError) throw new ThirdPartyRevokedError(err.message);
    if (err instanceof SignInError) throw new ThirdPartyError(err.message);
    throw err;
  }
}

export function discover(issuer: string, deps: ThirdPartyDeps): Promise<AuthServer> {
  return asThirdParty(() => discoverServer(issuer, deps));
}

/** Registers Connect as a public client for one redirect address; returns its client id. */
export function registerClient(
  server: AuthServer,
  client: ClientDetails,
  scopes: readonly string[],
  deps: ThirdPartyDeps,
): Promise<string> {
  return asThirdParty(() => register(server, client, scopes, deps));
}

/**
 * Swaps the code the person came back with for their token. A client the
 * third party no longer knows is a `StaleClientError`, so Connect can
 * register again.
 */
export function exchangeCode(
  server: AuthServer,
  request: CodeExchange,
  deps: ThirdPartyDeps,
): Promise<Grant> {
  return asThirdParty(() => exchange(server, request, deps));
}

/**
 * Swaps a refresh token for a new access token (and usually a new refresh
 * token). One it won't take any more is a `ThirdPartyRevokedError`: the
 * person has to sign in again.
 */
export function renewGrant(
  server: AuthServer,
  renewal: Renewal,
  deps: ThirdPartyDeps,
): Promise<Grant> {
  return asThirdParty(() => renew(server, renewal, deps));
}
