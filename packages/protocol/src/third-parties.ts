import { z } from "zod";
import { WebUrl } from "./urls.ts";

/**
 * Third parties: other companies' agents (Revnu, say), which Nibblets
 * Connect lists in the sidebar beside the person's nibblets. The person
 * connects one to their account once, signing in on its own site, and can
 * then talk to it and answer what it's waiting on, as they would a nibblet.
 * Which there are is up to plugins (`@nibblets/third-party`); nothing here
 * or in the UI knows one from another. Their credentials stay in Connect,
 * sealed, and never reach the browser.
 */

const Timestamp = z.iso.datetime();

/** A plugin's id, e.g. `revnu`. */
export const ThirdPartyPluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export type ThirdPartyPluginId = z.infer<typeof ThirdPartyPluginId>;

/** Connecting by pasting a token from the third party's own settings. */
export const ThirdPartyTokenEntry = z.object({
  label: z.string(),
  placeholder: z.string(),
  /** Where to find one, and what to tick. */
  hint: z.string(),
});
export type ThirdPartyTokenEntry = z.infer<typeof ThirdPartyTokenEntry>;

/** A third party Connect can connect, for Settings to offer. */
export const ThirdPartyKind = z.object({
  id: ThirdPartyPluginId,
  name: z.string(),
  /** A line on what it is. */
  description: z.string(),
  /** Its logo, as a `data:` URL. */
  icon: z.string(),
  /** Connecting by signing in on its site. */
  signIn: z.boolean(),
  /** Connecting with a pasted token instead; null when it can't. */
  token: ThirdPartyTokenEntry.nullable(),
});
export type ThirdPartyKind = z.infer<typeof ThirdPartyKind>;

/**
 * What a connection may do, from what the person allowed when connecting.
 * Fixed for its life: allowing more means connecting again.
 */
export const ThirdPartyAbilities = z.object({
  /** Read its conversation and message it. */
  chat: z.boolean(),
  /** See whether it's working. */
  status: z.boolean(),
  /** See what it's waiting on the person for. */
  requests: z.boolean(),
  /** Answer those. */
  decide: z.boolean(),
});
export type ThirdPartyAbilities = z.infer<typeof ThirdPartyAbilities>;

/** What it's up to now, for the sidebar. */
export const ThirdPartyActivity = z.object({
  working: z.boolean(),
  /** How many things are waiting on the person. */
  waiting: z.number().int().nonnegative(),
});
export type ThirdPartyActivity = z.infer<typeof ThirdPartyActivity>;

/** `live` while it works; `revoked` once the third party stopped taking its credential. */
export const ThirdPartyState = z.enum(["live", "revoked"]);
export type ThirdPartyState = z.infer<typeof ThirdPartyState>;

/** A connected third party, as the UI sees it: never its credential. */
export const ThirdParty = z.object({
  id: z.string(),
  plugin: ThirdPartyPluginId,
  /** Whose it is there: "Acme". */
  account: z.string(),
  state: ThirdPartyState,
  abilities: ThirdPartyAbilities,
  connectedAt: Timestamp,
  /** Null when it couldn't be asked; `problem` says why. */
  activity: ThirdPartyActivity.nullable(),
  problem: z.string().nullable(),
});
export type ThirdParty = z.infer<typeof ThirdParty>;

export const ThirdPartyList = z.object({
  /** False when this Connect has no key to seal credentials with, so none can be connected. */
  enabled: z.boolean(),
  kinds: z.array(ThirdPartyKind),
  parties: z.array(ThirdParty),
});
export type ThirdPartyList = z.infer<typeof ThirdPartyList>;

/** One message in the conversation, oldest first. */
export const ThirdPartyMessage = z.object({
  id: z.string(),
  /** `person` for what was sent from here (or elsewhere on the same connection). */
  role: z.enum(["person", "agent"]),
  text: z.string(),
  at: Timestamp,
});
export type ThirdPartyMessage = z.infer<typeof ThirdPartyMessage>;

/** What an action asks for before it's taken. */
export const ThirdPartyInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("text"),
    required: z.boolean(),
    placeholder: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(1),
  }),
]);
export type ThirdPartyInput = z.infer<typeof ThirdPartyInput>;

/**
 * What taking an action does beyond the third party: `ships` sends,
 * publishes or spends something; `answers` tells it to carry on, which it
 * may act on; `none` changes nothing outside it.
 */
export const ThirdPartyEffect = z.enum(["ships", "answers", "none"]);
export type ThirdPartyEffect = z.infer<typeof ThirdPartyEffect>;

export const ThirdPartyAction = z.object({
  id: z.string(),
  label: z.string(),
  /** The main button. At most one per request. */
  primary: z.boolean(),
  effect: ThirdPartyEffect,
  input: ThirdPartyInput,
});
export type ThirdPartyAction = z.infer<typeof ThirdPartyAction>;

/** Something it's waiting on the person for: an approval, a question, a choice. */
export const ThirdPartyRequest = z.object({
  id: z.string(),
  title: z.string(),
  /** Markdown. */
  body: z.string().nullable(),
  /** More it attached, such as a draft: each shown under its label, as plain text. */
  details: z.array(z.object({ label: z.string(), text: z.string() })),
  priority: z.enum(["high", "normal", "low"]),
  createdAt: Timestamp,
  /** When it goes ahead by itself unless someone acts first. */
  goesAheadAt: Timestamp.nullable(),
  actions: z.array(ThirdPartyAction),
  /** Where to see it in the third party's own app, and what to call that link. */
  open: z.object({ url: WebUrl, label: z.string() }).nullable(),
});
export type ThirdPartyRequest = z.infer<typeof ThirdPartyRequest>;

/** What the person filled in for an action. */
export const ThirdPartyAnswer = z.object({
  text: z.string().max(8000).optional(),
  option: z.string().max(500).optional(),
});
export type ThirdPartyAnswer = z.infer<typeof ThirdPartyAnswer>;

/**
 * A message to send. `clientId` makes retrying safe: the same one is sent
 * once, however often it's posted.
 */
export const ThirdPartySend = z.object({
  text: z.string().trim().min(1).max(4000),
  clientId: z.string().regex(/^[\w.:-]{8,128}$/),
});
export type ThirdPartySend = z.infer<typeof ThirdPartySend>;

export const ThirdPartyTokenInput = z.object({ token: z.string().trim().min(1).max(1000) });
export type ThirdPartyTokenInput = z.infer<typeof ThirdPartyTokenInput>;
