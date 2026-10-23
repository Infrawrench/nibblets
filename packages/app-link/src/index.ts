import type {
  AppLinkDescription,
  AppLinkField,
  AppLinkPluginId,
  AppLinkSettings,
} from "@nibblets/protocol";

/**
 * The contract every app link plugin fulfils. A plugin is an app nibblets
 * can act in under identities of their own (Infrawrench, say). The server
 * is linked to the app once, with a code the person approves in the app
 * (like `gh auth login`); then each nibblet the person picks is granted a
 * credential of its own from that link, with the scopes they tick. The
 * server keeps the links, the grants and their secrets; a plugin only
 * talks to its app, and knows everything about it, so neither the server
 * nor the UI knows one app from another.
 */
export interface AppLinkPlugin {
  /**
   * Starts linking. The person goes to `verificationUrl` and approves
   * `userCode` there; the server then calls `poll` until it settles.
   */
  begin(request: LinkRequest): Promise<LinkStart>;
  /**
   * Asks the app whether the person has answered. Called every `interval`
   * seconds (or longer, after `slow_down`) until it isn't pending.
   */
  poll(start: LinkStart): Promise<LinkPoll>;
  /** What the link may grant now, for a nibblet's form. */
  describe(link: LinkRef): Promise<AppLinkDescription>;
  /** Makes a nibblet a credential of its own on the link. */
  grant(link: LinkRef, request: GrantRequest): Promise<Grant>;
  /** Changes what a grant may do. */
  update(link: LinkRef, grant: GrantRef, request: GrantUpdate): Promise<GrantUpdated>;
  /** Revokes a grant's credential. Revoking one that's already gone is not an error. */
  revoke(link: LinkRef, grant: GrantRef): Promise<void>;
  /**
   * Revokes the link, and with it every grant it made. Unlinking a link
   * the app already revoked is not an error.
   */
  unlink(link: LinkRef): Promise<void>;
  /** Who the link is as now, and which of its grants the app has revoked. */
  inspect(link: LinkRef): Promise<LinkInspection>;
  /**
   * Takes on a link the app made and approved some other way (say the app
   * set this server up itself, already signed in): checks its secret with
   * the app, and says who it is, as a `linked` poll would. Throws an
   * `AppLinkError` when the app doesn't take it. Optional: an app that can
   * only link with a code doesn't have it.
   */
  adopt?(secret: string): Promise<LinkAdopted>;
  /**
   * How a nibblet reaches the app with a grant. Only ever sent to its
   * guard, since it carries the grant's secret.
   */
  connection(grant: GrantSecret): AppLinkConnection;
}

/** What the server tells the app about itself when it links. */
export interface LinkRequest {
  /** Who's asking, as the app should show it: "Nibblets on PogAir-4". */
  label: string;
  /** Scopes to suggest the person allows, if the server has an idea. */
  requestedScopes?: string[];
}

export interface LinkStart {
  /** What the plugin polls with. A secret: kept on the server, never shown. */
  secret: string;
  userCode: string;
  verificationUrl: string;
  /** The same page with the code filled in, if the app has one. */
  verificationUrlComplete: string | null;
  /** When the code stops working. */
  expiresAt: Date;
  /** Seconds to wait between polls. */
  interval: number;
}

export type LinkPoll =
  | { status: "pending" }
  /** Polled too soon: wait longer between polls from now on. */
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "linked"; link: LinkRef; account: string };

export interface LinkAdopted {
  link: LinkRef;
  account: string;
}

/** A link as the server keeps it. */
export interface LinkRef {
  /** The app's own id for it. */
  ref: string;
  /** What the server authenticates to the app with. */
  secret: string;
}

export interface GrantRequest {
  /** The server's id for whom it's for, the nibblet's, so the app can tell grants apart. */
  externalId: string;
  /** What the app calls it: the nibblet's name. */
  label: string;
  scopes: string[];
  /** What to narrow it to, out of the description's `providers`; empty for all. */
  providers: string[];
}

export interface GrantUpdate {
  label?: string;
  scopes?: string[];
  providers?: string[];
}

export interface GrantRef {
  /** The app's own id for it. */
  ref: string;
}

export interface Grant extends GrantRef {
  /** The grant's own credential. */
  secret: string;
  /** What the app made it with, which may be narrower than asked. */
  scopes: string[];
  providers: string[];
}

export interface GrantUpdated {
  scopes: string[];
  providers: string[];
}

export interface GrantSecret extends GrantRef {
  secret: string;
}

export interface LinkInspection {
  account: string;
  /** Refs of grants the app has revoked (from its own settings, say). */
  revoked: string[];
}

export interface AppLinkConnection {
  /** An MCP server the guard serves behind its gate, under the link's name. */
  mcp?: { url: string; headers: Record<string, string> };
  /** What the nibblet is told about the app, beyond its scopes. */
  prompt?: string;
}

/**
 * An error whose message is safe to show the person: no credentials. Any
 * other error is logged on the server and shown as a plain failure.
 */
export class AppLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppLinkError";
  }
}

/**
 * The app says the link, or a grant on it, has been revoked there: the
 * server marks it so, and stops handing it out.
 */
export class AppLinkRevokedError extends AppLinkError {
  readonly what: "link" | "grant";
  constructor(what: "link" | "grant", message: string) {
    super(message);
    this.name = "AppLinkRevokedError";
    this.what = what;
  }
}

export interface AppLinkDeps {
  fetch: typeof globalThis.fetch;
}

/**
 * How the server loads a plugin. A factory describes the plugin, and the
 * form it needs before linking (`fields`, such as the app's address), and
 * makes it with a link's settings.
 */
export interface AppLinkFactory {
  readonly id: AppLinkPluginId;
  readonly name: string;
  /** One line for Settings, on what linking it gives a nibblet. */
  readonly description: string;
  /** Its app's logo, as a `data:` URL. */
  readonly icon: string;
  readonly fields: readonly AppLinkField[];
  /** Throws an `AppLinkError` saying what's wrong with settings that won't do. */
  create(settings: AppLinkSettings, deps: AppLinkDeps): AppLinkPlugin;
}

export function defineAppLinkFactory(factory: AppLinkFactory): AppLinkFactory {
  return factory;
}

/** A field for a plugin's form; optional text with no default unless `more` says otherwise. */
export function defineField(
  key: string,
  label: string,
  more: Partial<Omit<AppLinkField, "key" | "label">> = {},
): AppLinkField {
  return {
    key,
    label,
    hint: null,
    placeholder: null,
    default: null,
    required: false,
    ...more,
  };
}

/**
 * What a form sent, as a plugin takes it: trimmed, blanks filled with their
 * defaults, and keys that aren't fields dropped. Throws an `AppLinkError`
 * for a required field that's still blank.
 */
export function resolveSettings(
  fields: readonly AppLinkField[],
  input: AppLinkSettings,
): AppLinkSettings {
  const settings: AppLinkSettings = {};
  for (const field of fields) {
    const value = input[field.key]?.trim() || field.default || "";
    if (value) settings[field.key] = value;
    else if (field.required) throw new AppLinkError(`${field.label} is needed`);
  }
  return settings;
}
