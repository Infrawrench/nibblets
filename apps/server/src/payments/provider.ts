import type { CardPurpose, PaymentKind, SetupField } from "@nibblet/protocol";

/**
 * Payment providers are plugins. Each has a kind, and every provider of a
 * kind works the same way to the nibblet: cards are cards whichever bank
 * issued them. Adding a bank means writing one `CardProvider` and listing it
 * in `registry.ts`; adding crypto means writing a `CryptoProvider`.
 */

/** A connected account as its provider sees it: its credentials and setup choices. */
export interface ProviderAccount {
  id: string;
  label: string;
  credentials: Record<string, string>;
  config: Record<string, string>;
}

/** A plain-language error from a provider, safe to show the person and the nibblet. */
export class PaymentError extends Error {
  override readonly name = "PaymentError";
}

export interface PaymentProviderBase<K extends PaymentKind> {
  readonly id: string;
  readonly kind: K;
  readonly label: string;
  readonly description: string;
  /** Kept out of the UI and the tools: for providers that aren't ready to offer. */
  readonly hidden?: boolean;
  /** The money it works in, e.g. "USD". */
  readonly currency: string;
  /** Asked for first: an API key, which environment. */
  readonly credentialFields: SetupField[];
  /**
   * Checks the credentials and returns the choices they unlock (which
   * cardholder, which account money comes from), with any current values
   * from `config` as defaults. Throws a `PaymentError` if they don't work.
   */
  setup(
    credentials: Record<string, string>,
    config?: Record<string, string>,
  ): Promise<SetupField[]>;
  /** Whether the account works, and a few lines about it for the settings page. */
  describe(
    account: ProviderAccount,
  ): Promise<{ ok: boolean; detail: string | null; summary: string[] }>;
}

export interface CardDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  nameOnCard: string | null;
}

export interface CardRequest {
  purpose: CardPurpose;
  /**
   * What the card may spend. For a one-time card it's what the nibblet asked
   * for; for a recurring one, the rest of its limit.
   */
  amountCents: number;
  /**
   * The most the card may expose in all. A provider that can't make a card
   * with exactly `amountCents` (one handing out cards the person made) may
   * pick one up to this, and reports what it picked as `limitCents`.
   */
  maxCents: number;
  /** How often the card's own limit starts afresh, where the provider sets one. */
  interval: "monthly" | "yearly";
  /** A label for the card in the provider's dashboard. */
  nickname: string;
  /** Provider refs already handed out, so the same card never goes to two nibblets. */
  inUse: ReadonlySet<string>;
}

export interface IssuedProviderCard {
  ref: string;
  lastFour: string;
  /** What the card can really spend in all, which is what's held against the limit. */
  limitCents: number;
  source: "created" | "pool";
  details: CardDetails;
  /** Something the person should know, like "fell back to an agent card". */
  note?: string;
}

export interface Charge {
  /** The provider's transaction id. */
  ref: string;
  cardRef: string;
  /** Positive for a charge, negative for a refund. */
  amountCents: number;
  description: string;
  at: Date;
}

/** Credit and debit cards, from any vendor. */
export interface CardProvider extends PaymentProviderBase<"card"> {
  issue(account: ProviderAccount, request: CardRequest): Promise<IssuedProviderCard>;
  /** The details again, for a container that restarted and lost its copy. */
  reveal(account: ProviderAccount, ref: string): Promise<CardDetails>;
  /** Closes a card for good. A card that's already closed counts as done. */
  cancel(account: ProviderAccount, ref: string): Promise<void>;
  /** Charges and refunds on these cards since a time. */
  charges(account: ProviderAccount, refs: string[], since: Date): Promise<Charge[]>;
}

/**
 * Crypto wallets and exchanges. None ship yet, so the kind is hidden from
 * the UI and the tools, but the shape is here for the first one.
 */
export interface CryptoProvider extends PaymentProviderBase<"crypto"> {
  /** Sends an amount of an asset to an address; returns the transaction id. */
  send(
    account: ProviderAccount,
    request: { asset: string; network: string; to: string; amount: string; memo?: string },
  ): Promise<{ ref: string }>;
}

export type PaymentProvider = CardProvider | CryptoProvider;
