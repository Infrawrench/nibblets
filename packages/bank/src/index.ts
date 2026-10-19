import {
  MASKED,
  type AssetInfo,
  type BankField,
  type BankInstrument,
  type BankProviderId,
  type BankSettings,
  type CardKind,
  type CardSecret,
} from "@nibblet/protocol";

export * from "./budget.ts";
export * from "./keys.ts";
export * from "./wallet.ts";

/**
 * The contract every bank plugin fulfils. A plugin is somewhere money comes
 * from: a card issuer, or a crypto treasury that funds a fresh wallet per
 * card. The server keeps the cards' records and the nibblets' limits; a
 * plugin only talks to its provider. It holds its own credentials, which
 * never leave the server.
 */
export interface BankPlugin {
  readonly id: BankProviderId;
  /** For Settings, e.g. "Lithic (sandbox)". */
  readonly label: string;
  /** The one asset its cards are in. */
  readonly asset: AssetInfo;
  /** What its cards are, for how they're shown. */
  readonly instrument: BankInstrument;
  /** Where to send money to top it up (a treasury's address), or null for an account topped up elsewhere. */
  readonly fundAt: string | null;
  /**
   * Asks the provider something harmless, to see that its settings work
   * before they're saved. Throws a `BankError` saying what's wrong.
   */
  check(): Promise<void>;
  /** What's left to fund cards from, if the provider says; throws when it can't be reached. */
  balance(): Promise<bigint | null>;
  /**
   * Makes a card that can spend at most `limit` over its whole life. A
   * single-use card should close itself after its first purchase where the
   * provider can do that; otherwise `inspect` reports it used and the server
   * closes it. Throw a `BankError` only when nothing was made (a refusal);
   * anything else (a timeout, say) leaves the server unsure, and it calls
   * `find` later to see.
   */
  issue(request: IssueRequest): Promise<IssuedCard>;
  /**
   * The card an `issue` for this id made, if it made one: for when that
   * `issue` failed in a way that leaves it unclear. Null when there isn't one.
   */
  find(cardId: string): Promise<FoundCard | null>;
  /** The card's secret again, to write its file after the container restarts. */
  reveal(card: CardRef): Promise<CardSecret>;
  /** How much has gone out on it, and whether it's still open. */
  inspect(card: CardRef): Promise<CardUsage>;
  /**
   * Closes it for good, returning whatever wasn't spent where that's a thing
   * (a wallet's balance goes back to the treasury). Closing a closed card is
   * not an error. `settled` is false when it can't be finished yet (a wallet
   * whose funding isn't seen yet has nothing to sweep); the server calls it
   * again later.
   */
  close(card: CardRef): Promise<CloseResult>;
}

/**
 * An error whose message is safe to show the nibblet and the person: no
 * credentials, URLs or keys. From `issue`, it also means nothing was made.
 * Any other error is logged on the server and shown as a plain failure.
 */
export class BankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankError";
  }
}

export interface IssueRequest {
  /** The server's id for it, fixed before the provider is asked. */
  cardId: string;
  nibbletId: string;
  /** For the provider's own records, e.g. a card's memo. */
  label: string;
  kind: CardKind;
  limit: bigint;
}

export interface IssuedCard {
  /** The provider's own id for it, kept to find it again. */
  ref: string;
  /** Safe to show anywhere: `•••• 4242`, or an address. */
  display: string;
  secret: CardSecret;
}

export interface FoundCard {
  ref: string;
  display: string;
}

export interface CardRef {
  id: string;
  ref: string;
  kind: CardKind;
  limit: bigint;
}

export interface CardUsage {
  open: boolean;
  /** Everything that's gone out on it, fees included. */
  spent: bigint;
  /** Whether anything has been spent at all; a used single-use card is closed. */
  used: boolean;
}

export interface CloseResult extends CardUsage {
  /** Whether everything on it is accounted for, so it can be recorded as closed. */
  settled: boolean;
}

export function defineBankPlugin(plugin: BankPlugin): BankPlugin {
  return plugin;
}

/**
 * A plugin's settings by field key: saved in Settings, or read from the
 * server's environment, whose variables have the same names.
 */
export type BankSettingValues = Readonly<Record<string, string | undefined>>;

export interface BankDeps {
  fetch: typeof globalThis.fetch;
  log(message: string): void;
}

/**
 * How the server loads a plugin: from its settings, or not at all (null)
 * when they aren't there. Settings that are there but wrong throw, with a
 * message fit to show under the form, so a typo doesn't quietly turn a bank
 * off.
 */
export interface BankPluginFactory {
  readonly id: BankProviderId;
  /** What it's called before it's set up, e.g. "Bitcoin". */
  readonly name: string;
  /** A line on what it is, for choosing one to set up. */
  readonly about: string;
  /** What its cards are, for how they're shown. */
  readonly instrument: BankInstrument;
  /** What it needs, in the order the form asks for them. */
  readonly fields: readonly BankField[];
  fromSettings(settings: BankSettingValues, deps: BankDeps): BankPlugin | null;
}

export function defineBankFactory(factory: BankPluginFactory): BankPluginFactory {
  return factory;
}

/** A field for a plugin's form; plain, optional text unless `more` says otherwise. */
export function defineField(
  key: string,
  label: string,
  more: Partial<Omit<BankField, "key" | "label">> = {},
): BankField {
  return {
    key,
    label,
    hint: null,
    placeholder: null,
    required: false,
    secret: false,
    options: null,
    generate: null,
    lockedByCards: false,
    ...more,
  };
}

export interface LoadedBanks {
  plugins: Map<BankProviderId, BankPlugin>;
  /** Plugins whose settings are there but wrong, with why. */
  errors: Map<BankProviderId, string>;
}

/** Loads every factory whose settings are present. */
export function loadBankPlugins(
  factories: readonly BankPluginFactory[],
  settings: ReadonlyMap<BankProviderId, BankSettingValues>,
  deps: BankDeps,
): LoadedBanks {
  const plugins = new Map<BankProviderId, BankPlugin>();
  const errors = new Map<BankProviderId, string>();
  const seen = new Set<BankProviderId>();
  for (const factory of factories) {
    if (seen.has(factory.id)) throw new Error(`Two bank plugins are called ${factory.id}`);
    seen.add(factory.id);
    try {
      const plugin = factory.fromSettings(settings.get(factory.id) ?? {}, deps);
      if (!plugin) continue;
      if (plugin.id !== factory.id) {
        throw new Error(`it calls itself ${plugin.id}, not ${factory.id}`);
      }
      plugins.set(plugin.id, plugin);
    } catch (err) {
      errors.set(factory.id, err instanceof Error ? err.message : String(err));
    }
  }
  return { plugins, errors };
}

export interface ResolvedSettings {
  source: "saved" | "env" | null;
  settings: BankSettings;
}

/**
 * A plugin's settings and where they're from: the ones saved in Settings if
 * there are any, or else whichever of its fields the environment sets.
 */
export function resolveSettings(
  factory: BankPluginFactory,
  saved: BankSettings | undefined,
  env: BankSettingValues,
): ResolvedSettings {
  if (saved) return { source: "saved", settings: saved };
  const settings: BankSettings = {};
  for (const field of factory.fields) {
    const value = env[field.key]?.trim();
    if (value) settings[field.key] = value;
  }
  return { source: Object.keys(settings).length > 0 ? "env" : null, settings };
}

/**
 * What a form sent, over what's there: a secret sent as `MASKED` keeps the
 * one it has, blanks are left out, and keys that aren't fields are dropped.
 */
export function mergeSettings(
  fields: readonly BankField[],
  input: BankSettings,
  current: BankSettings,
): BankSettings {
  const merged: BankSettings = {};
  for (const field of fields) {
    const sent = input[field.key]?.trim() ?? "";
    const value = field.secret && sent === MASKED ? (current[field.key] ?? "") : sent;
    if (value) merged[field.key] = value;
  }
  return merged;
}

/** Settings fit for the API: each secret that's set shown as `MASKED`. */
export function maskSettings(fields: readonly BankField[], settings: BankSettings): BankSettings {
  const masked: BankSettings = {};
  for (const field of fields) {
    const value = settings[field.key];
    if (value) masked[field.key] = field.secret ? MASKED : value;
  }
  return masked;
}

/** The fields that can't change while there are cards, which `next` changes from `current`. */
export function changedLockedFields(
  fields: readonly BankField[],
  current: BankSettings,
  next: BankSettings,
): BankField[] {
  return fields.filter((f) => f.lockedByCards && (current[f.key] ?? "") !== (next[f.key] ?? ""));
}

/** Reads a required setting, or says it's needed. */
export function requireSetting(settings: BankSettingValues, field: BankField): string {
  const value = settings[field.key]?.trim();
  if (!value) throw new Error(`${field.label} is needed`);
  return value;
}

/** An optional setting, trimmed; undefined when it's blank. */
export function optionalSetting(settings: BankSettingValues, field: BankField): string | undefined {
  return settings[field.key]?.trim() || undefined;
}

/** `•••• 4242`. */
export function maskedCard(lastFour: string): string {
  return `•••• ${lastFour}`;
}
