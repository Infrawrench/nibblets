import type {
  ThirdPartyAbilities,
  ThirdPartyActivity,
  ThirdPartyAnswer,
  ThirdPartyMessage,
  ThirdPartyPluginId,
  ThirdPartyRequest,
  ThirdPartyTokenEntry,
} from "@nibblets/protocol";
import type { ThirdPartyDeps, ThirdPartySignIn } from "./oauth.ts";

export * from "./errors.ts";
export * from "./oauth.ts";

/**
 * The contract every third party plugin fulfils. A third party is another
 * company's agent (Revnu, say) that Nibblets Connect shows in the sidebar
 * beside the person's nibblets. The person connects it once, signing in on
 * its site or pasting a token; Connect keeps the credential sealed, and a
 * plugin is made with it for each call. A plugin knows everything about
 * its third party, so neither Connect nor the UI knows one from another.
 */
export interface ThirdPartyAgent {
  /** What it's up to now, for the sidebar. Only asks what its abilities allow. */
  activity(): Promise<ThirdPartyActivity>;
  /** The conversation on this connection, oldest first. */
  thread(): Promise<ThirdPartyMessage[]>;
  /** Sends a message. The same `clientId` sends once, however often it's retried. */
  send(text: string, clientId: string): Promise<void>;
  /** What it's waiting on the person for. */
  requests(): Promise<ThirdPartyRequest[]>;
  /** Takes one of a request's actions, with what the person filled in. */
  act(requestId: string, actionId: string, answer: ThirdPartyAnswer): Promise<void>;
}

/** Who a credential is, as the third party says. */
export interface ThirdPartyIdentity {
  /** Its own id for the account, so connecting it again replaces the old connection. */
  ref: string;
  /** What to call the account: "Acme". */
  account: string;
  abilities: ThirdPartyAbilities;
}

/**
 * How Connect loads a plugin. A factory describes the third party and how
 * it's connected, checks a credential, and makes the plugin with one.
 */
export interface ThirdPartyFactory {
  readonly id: ThirdPartyPluginId;
  readonly name: string;
  /** One line on what it is, for Settings. */
  readonly description: string;
  /** Its logo, as a `data:` URL. */
  readonly icon: string;
  /** Signing in on its site; null when it has no way to. */
  readonly signIn: ThirdPartySignIn | null;
  /** Pasting a token instead; null when it can't be. */
  readonly token: ThirdPartyTokenEntry | null;
  /**
   * Who a credential is and what it may do. Throws a `ThirdPartyError`
   * (a `ThirdPartyRevokedError` for one it doesn't know) when it won't do.
   */
  identify(credential: string, deps: ThirdPartyDeps): Promise<ThirdPartyIdentity>;
  create(credential: string, abilities: ThirdPartyAbilities, deps: ThirdPartyDeps): ThirdPartyAgent;
}

export function defineThirdParty(factory: ThirdPartyFactory): ThirdPartyFactory {
  return factory;
}
