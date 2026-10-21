import type { AssetInfo, BankProviderId, CardKind, CardSecret } from "@nibblet/protocol";

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

/** What a plugin reads its settings from: the server's environment. */
export type BankEnv = Readonly<Record<string, string | undefined>>;

export interface BankDeps {
  fetch: typeof globalThis.fetch;
  log(message: string): void;
}

/**
 * How the server loads a plugin: from its settings, or not at all (null)
 * when they aren't there. Settings that are there but wrong throw, so a
 * typo doesn't quietly turn a bank off.
 */
export interface BankPluginFactory {
  readonly id: BankProviderId;
  /** The variables it reads, for docs and errors. */
  readonly env: readonly string[];
  fromEnv(env: BankEnv, deps: BankDeps): BankPlugin | null;
}

export function defineBankFactory(factory: BankPluginFactory): BankPluginFactory {
  return factory;
}

export interface LoadedBanks {
  plugins: Map<BankProviderId, BankPlugin>;
  /** Plugins whose settings are there but wrong, with why. */
  errors: Map<BankProviderId, string>;
}

/** Loads every factory whose settings are present. */
export function loadBankPlugins(
  factories: readonly BankPluginFactory[],
  env: BankEnv,
  deps: BankDeps,
): LoadedBanks {
  const plugins = new Map<BankProviderId, BankPlugin>();
  const errors = new Map<BankProviderId, string>();
  const seen = new Set<BankProviderId>();
  for (const factory of factories) {
    if (seen.has(factory.id)) throw new Error(`Two bank plugins are called ${factory.id}`);
    seen.add(factory.id);
    try {
      const plugin = factory.fromEnv(env, deps);
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

/** Reads a required setting, or says which one is missing. */
export function requireEnv(env: BankEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} isn't set`);
  return value;
}

/** `•••• 4242`. */
export function maskedCard(lastFour: string): string {
  return `•••• ${lastFour}`;
}
