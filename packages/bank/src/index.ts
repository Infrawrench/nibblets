import {
  MASKED,
  type AssetInfo,
  type BankField,
  type BankInstrument,
  type BankProviderId,
  type BankSettings,
  type CardKind,
  type CardSecret,
} from "@nibblets/protocol";

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
  /** The bank's id. A factory makes it with its own; the loader gives it the bank's. */
  readonly id: BankProviderId;
  /** For Settings, e.g. "Lithic (sandbox)"; the loader puts the bank's name in front. */
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
  /**
   * Set when the provider asks the server before each purchase on a card
   * (see `PurchaseHook`); absent when it doesn't, or isn't set up to.
   */
  readonly purchases?: PurchaseHook;
}

/**
 * The provider asking whether a purchase may go through, as it happens.
 * On a nibblets card, the server answers no unless the card is open and
 * the purchase fits what's left on it, and no to anything it can't make
 * out. A provider may ask about every card on the account, so purchases on
 * cards that aren't nibblets' are let through, to the provider's own rules.
 */
export interface PurchaseHook {
  /**
   * The purchase a request asks about, if this bank's provider signed it;
   * null if it didn't (it may be another bank's). Throws when it's signed
   * but can't be read.
   */
  read(request: HookRequest): Purchase | null;
  /** What to send back to the provider. */
  answer(approved: boolean): HookResponse;
}

export interface HookRequest {
  headers: Headers;
  /** The body exactly as it came, which signatures are made over. */
  body: string;
}

export interface HookResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Purchase {
  /** The provider's id for the card (`IssuedCard.ref`). */
  ref: string;
  /**
   * The provider's id for the authorisation. A merchant can ask for more on
   * one it already has (a tip, a hotel stay running on), as another request
   * with the same id.
   */
  authorization: string;
  /** What this request adds, in `asset`'s smallest unit. */
  amount: bigint;
  /** Its asset's code, e.g. `USD`. */
  asset: string;
  /** Who it's at, for the log. */
  merchant: string;
  /**
   * Whether the provider's card says it was made for a nibblet (Stripe's
   * metadata, say), so one this server doesn't know is declined rather
   * than taken for someone else's.
   */
  nibbletCard: boolean;
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
  /**
   * For a provider that can ask the server about each purchase: where the
   * person gives it the server's address, for Settings. Its banks do it
   * once their settings say how to check the provider's requests.
   */
  readonly purchaseHook?: { readonly where: string };
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
  /** Banks whose settings are there but wrong, with why. */
  errors: Map<BankProviderId, string>;
}

/** One bank to load: which plugin, with what settings. */
export interface BankEntry {
  id: BankProviderId;
  kind: BankProviderId;
  name: string;
  settings: BankSettingValues;
}

/** Loads every bank whose settings are complete, each under its own id. */
export function loadBankPlugins(
  factories: readonly BankPluginFactory[],
  banks: readonly BankEntry[],
  deps: BankDeps,
): LoadedBanks {
  const byId = new Map<BankProviderId, BankPluginFactory>();
  for (const factory of factories) {
    if (byId.has(factory.id)) throw new Error(`Two bank plugins are called ${factory.id}`);
    byId.set(factory.id, factory);
  }
  const plugins = new Map<BankProviderId, BankPlugin>();
  const errors = new Map<BankProviderId, string>();
  for (const bank of banks) {
    if (plugins.has(bank.id) || errors.has(bank.id)) {
      throw new Error(`Two banks are called ${bank.id}`);
    }
    try {
      const factory = byId.get(bank.kind);
      if (!factory) throw new Error(`there's no bank plugin called ${bank.kind}`);
      const plugin = factory.fromSettings(bank.settings, deps);
      if (!plugin) continue;
      if (plugin.id !== factory.id) {
        throw new Error(`it calls itself ${plugin.id}, not ${factory.id}`);
      }
      plugins.set(bank.id, asBank(plugin, bank.id, bank.name));
    } catch (err) {
      errors.set(bank.id, err instanceof Error ? err.message : String(err));
    }
  }
  return { plugins, errors };
}

/** A plugin as one bank: its own methods, under the bank's id, with its name in its label. */
function asBank(plugin: BankPlugin, id: BankProviderId, name: string): BankPlugin {
  return {
    id,
    label: name ? `${name} · ${plugin.label}` : plugin.label,
    asset: plugin.asset,
    instrument: plugin.instrument,
    fundAt: plugin.fundAt,
    check: () => plugin.check(),
    balance: () => plugin.balance(),
    issue: (request) => plugin.issue(request),
    find: (cardId) => plugin.find(cardId),
    reveal: (card) => plugin.reveal(card),
    inspect: (card) => plugin.inspect(card),
    close: (card) => plugin.close(card),
    ...(plugin.purchases ? { purchases: plugin.purchases } : {}),
  };
}

/** A bank as Settings saved it. */
export interface SavedBank {
  id: BankProviderId;
  kind: BankProviderId;
  name: string;
  settings: BankSettings;
}

export interface ResolvedBank extends SavedBank {
  source: "saved" | "env";
}

/**
 * Every bank set up: the ones saved in Settings, and for each plugin, one
 * from whichever of its fields the server's environment sets, under the
 * plugin's own id, unless a saved bank has taken that id over.
 */
export function resolveBanks(
  factories: readonly BankPluginFactory[],
  saved: readonly SavedBank[],
  env: BankSettingValues,
): ResolvedBank[] {
  const banks: ResolvedBank[] = saved.map((b) => ({ ...b, source: "saved" }));
  for (const factory of factories) {
    if (banks.some((b) => b.id === factory.id)) continue;
    const settings: BankSettings = {};
    for (const field of factory.fields) {
      const value = env[field.key]?.trim();
      if (value) settings[field.key] = value;
    }
    if (Object.keys(settings).length > 0) {
      banks.push({ id: factory.id, kind: factory.id, name: "", settings, source: "env" });
    }
  }
  return banks;
}

/**
 * An id for a new bank on a plugin: the plugin's own while it's free (so the
 * first bank has it), else the plugin's with the bank's name, made unique.
 */
export function newBankId(
  kind: BankProviderId,
  name: string,
  taken: ReadonlySet<BankProviderId>,
): BankProviderId {
  if (!taken.has(kind)) return kind;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = (slug ? `${kind}-${slug}` : kind).slice(0, 35).replace(/-+$/, "");
  if (stem !== kind && !taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
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
