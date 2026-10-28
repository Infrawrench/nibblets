import { z } from "zod";
import { WebUrl } from "./urls.ts";

/**
 * App links: other apps a nibblet can act in under an identity of its own.
 * The server is linked to an app once (an Infrawrench organisation, say),
 * with a code the person approves in that app. Then each nibblet can be
 * granted its own credential from the link, with the scopes the person
 * ticks. Which apps there are is up to plugins on the server
 * (`@nibblets/app-link`); nothing here or in the UI knows one from another.
 * Secrets (the link's, and each grant's) stay on the server, and a grant's
 * reach only the nibblet's guard, never the UI or the agent.
 */

const Timestamp = z.iso.datetime();

/** A plugin's id, e.g. `infrawrench`. Also the name its tools go by, for the first link on it. */
export const AppLinkPluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export type AppLinkPluginId = z.infer<typeof AppLinkPluginId>;

/** One setting a plugin asks for before linking, such as the app's address. */
export const AppLinkField = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string(),
  hint: z.string().nullable(),
  placeholder: z.string().nullable(),
  /** What it is when left blank. */
  default: z.string().nullable(),
  required: z.boolean(),
});
export type AppLinkField = z.infer<typeof AppLinkField>;

/** A link's settings, by field key. None of them is a secret. */
export const AppLinkSettings = z.record(z.string(), z.string().max(2000));
export type AppLinkSettings = z.infer<typeof AppLinkSettings>;

/** An app link plugin the server knows, for Settings to offer. */
export const AppLinkKind = z.object({
  id: AppLinkPluginId,
  name: z.string(),
  /** A line on what linking it gives a nibblet. */
  description: z.string(),
  /** Its logo, as a `data:` URL. */
  icon: z.string(),
  fields: z.array(AppLinkField),
});
export type AppLinkKind = z.infer<typeof AppLinkKind>;

/**
 * `linked` while it works; `revoked` once the app said it was taken away
 * (it answered 401), which leaves every grant on it dead too; `removing`
 * once the person removed it but the app couldn't be told yet, which the
 * server keeps trying.
 */
export const AppLinkState = z.enum(["linked", "revoked", "removing"]);
export type AppLinkState = z.infer<typeof AppLinkState>;

/** A link as the UI sees it: never its secret. */
export const AppLink = z.object({
  id: z.string(),
  plugin: AppLinkPluginId,
  /** What its tools are called in a nibblet: the plugin's id, or with more after it for a second link. */
  name: z.string(),
  /** Who it's linked as, in the app's words: "Acme on Infrawrench". */
  account: z.string(),
  settings: AppLinkSettings,
  state: AppLinkState,
  /** Why it's in the state it's in, when that needs saying. */
  detail: z.string().nullable(),
  createdAt: Timestamp,
});
export type AppLink = z.infer<typeof AppLink>;

/** A link waiting for the person to approve it in the app. */
export const AppLinkAttempt = z.object({
  id: z.string(),
  plugin: AppLinkPluginId,
  /**
   * What to type, or check, on the app's page. Null when they sign in
   * there instead, and the app sends them back to the server.
   */
  userCode: z.string().nullable(),
  /** Only ever http or https, since the UI opens it. */
  verificationUrl: WebUrl,
  /** The same page with the code filled in, when the app has one. */
  verificationUrlComplete: WebUrl.nullable(),
  expiresAt: Timestamp,
});
export type AppLinkAttempt = z.infer<typeof AppLinkAttempt>;

export const AppLinks = z.object({
  links: z.array(AppLink),
  attempts: z.array(AppLinkAttempt),
});
export type AppLinks = z.infer<typeof AppLinks>;

/** How an attempt ended. */
export const AppLinkOutcome = z.enum(["linked", "denied", "expired", "cancelled", "failed"]);
export type AppLinkOutcome = z.infer<typeof AppLinkOutcome>;

/** Scopes as the app groups and names them, for ticking. */
export const AppScopeGroup = z.object({
  title: z.string(),
  scopes: z.array(z.object({ value: z.string(), label: z.string() })),
});
export type AppScopeGroup = z.infer<typeof AppScopeGroup>;

/** Something in the app a grant can be narrowed to, such as one cloud provider. */
export const AppLinkProvider = z.object({ id: z.string(), name: z.string() });
export type AppLinkProvider = z.infer<typeof AppLinkProvider>;

/** What a link may grant a nibblet, as the app says now. */
export const AppLinkDescription = z.object({
  account: z.string(),
  /** Only scopes within `ceiling`. */
  scopeGroups: z.array(AppScopeGroup),
  /** What a grant can be narrowed to; null when the app has no such thing. */
  providers: z.array(AppLinkProvider).nullable(),
  /** The most any grant on it may have. */
  ceiling: z.array(z.string()),
  /**
   * The scopes choosing providers limits to them. A grant narrowed to some
   * providers may only have these, since any other would still reach every
   * provider. Null when there's no such limit.
   */
  narrowable: z.array(z.string()).nullable().default(null),
});
export type AppLinkDescription = z.infer<typeof AppLinkDescription>;

/**
 * `active` while it works; `revoked` once the app said it was taken away;
 * `revoking` once it was turned off here but the app couldn't be told yet.
 * Only active grants reach the nibblet.
 */
export const AppGrantState = z.enum(["active", "revoked", "revoking"]);
export type AppGrantState = z.infer<typeof AppGrantState>;

/** One nibblet's grant on one link, as the UI sees it: never its secret. */
export const AppGrant = z.object({
  nibbletId: z.string(),
  linkId: z.string(),
  scopes: z.array(z.string()),
  /** Empty for all of them. */
  providers: z.array(z.string()),
  state: AppGrantState,
  detail: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AppGrant = z.infer<typeof AppGrant>;

/** One app link's tools, as a nibblet's guard serves them behind its gate. */
export const AppLinkServer = z.object({
  /** The name its tools go by: the link's. */
  name: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  /** Only these of its tools are listed and allowed; null for all of them. */
  tools: z.array(z.string()).nullable().default(null),
  /**
   * Only calls acting on these of the app's providers are allowed: the one
   * a call's `argument` names, or `home` when it names none (and always, for
   * tools in `actHome`). Null for all of them.
   */
  providers: z
    .object({
      argument: z.string(),
      allowed: z.array(z.string()),
      home: z.string(),
      actHome: z.array(z.string()),
    })
    .nullable()
    .default(null),
});
export type AppLinkServer = z.infer<typeof AppLinkServer>;
