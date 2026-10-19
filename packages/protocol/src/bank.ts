import { z } from "zod";

/**
 * Money a nibblet can spend: virtual cards, and crypto wallets that work
 * like them. The person gives each nibblet a spending limit per asset; the
 * nibblet asks for a card (`card_request`) within it and kills it when it's
 * done (`card_kill`). Where the money comes from is a bank plugin on the
 * server (a card issuer, a Bitcoin or Ethereum treasury), which holds every
 * credential. A card's details only reach the nibblet as a file in its
 * container, never in a tool result, so they stay out of the transcript.
 */

const Timestamp = z.iso.datetime();

/** A bank plugin's id, e.g. `lithic`, `bitcoin`, `ethereum`. */
export const BankProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export type BankProviderId = z.infer<typeof BankProviderId>;

/** An asset's code: `USD`, `BTC`, `ETH`. */
export const AssetCode = z.string().regex(/^[A-Z0-9]{2,10}$/);
export type AssetCode = z.infer<typeof AssetCode>;

/** How an asset is counted: an amount is a whole number of its smallest unit. */
export const AssetInfo = z.object({
  code: AssetCode,
  /** Cents are 2, satoshis 8, wei 18. */
  decimals: z.int().min(0).max(36),
});
export type AssetInfo = z.infer<typeof AssetInfo>;

/**
 * An amount in an asset's smallest unit (cents, satoshis, wei), as a string
 * of digits, since wei don't fit in a JSON number.
 */
export const MinorAmount = z.string().regex(/^(0|[1-9]\d{0,77})$/, "A whole number of minor units");
export type MinorAmount = z.infer<typeof MinorAmount>;

export const SpendingPeriod = z.enum(["day", "week", "month", "total"]);
export type SpendingPeriod = z.infer<typeof SpendingPeriod>;

/**
 * How much a nibblet may put on cards in one asset per period (UTC). Every
 * card counts for its whole limit while it's open, whenever it was made, so
 * cards left open can't pile up past the limit; once it's closed, it counts
 * for what was spent on it, in the period it was made in.
 */
export const SpendingLimit = z.object({
  asset: AssetCode,
  amount: MinorAmount,
  period: SpendingPeriod,
});
export type SpendingLimit = z.infer<typeof SpendingLimit>;

export const SpendingLimits = z
  .array(SpendingLimit)
  .max(20)
  .refine((list) => new Set(list.map((l) => l.asset)).size === list.length, "One limit per asset");

/** `single_use` closes after its first purchase; `multi_use` stays open until killed. */
export const CardKind = z.enum(["single_use", "multi_use"]);
export type CardKind = z.infer<typeof CardKind>;

/**
 * `pending` while the provider is asked for it (or, if that didn't answer,
 * until the server finds out whether it was made); `closing` once it's been
 * killed but the provider hasn't settled it yet (a wallet whose funding
 * isn't seen yet can't be swept). Only `closed` cards stop counting in full
 * against their limit.
 */
export const CardState = z.enum(["pending", "open", "closing", "closed"]);
export type CardState = z.infer<typeof CardState>;

/**
 * Who closed a card: the nibblet, the person, the provider (a single-use card
 * that's been used), or the server (one that never reached its container).
 */
export const CardClosedBy = z.enum(["nibblet", "user", "provider", "server"]);
export type CardClosedBy = z.infer<typeof CardClosedBy>;

/** A card as the API and tools show it: nothing here can be spent with. */
export const Card = z.object({
  id: z.string(),
  nibbletId: z.string(),
  provider: BankProviderId,
  asset: AssetInfo,
  kind: CardKind,
  limit: MinorAmount,
  /** As of the last check with the provider. */
  spent: MinorAmount,
  /** What the nibblet said it's for. */
  purpose: z.string(),
  /** Safe to show: `•••• 4242`, or a wallet's address. */
  display: z.string(),
  state: CardState,
  closedBy: CardClosedBy.nullable(),
  createdAt: Timestamp,
  closedAt: Timestamp.nullable(),
});
export type Card = z.infer<typeof Card>;

/** What a card can be spent with. Only ever sent over the runner socket, and written to a file. */
export const CardSecret = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("card"),
    pan: z.string(),
    cvv: z.string(),
    expMonth: z.string(),
    expYear: z.string(),
    /** Some issuers want a billing address; the nibblet uses this one. */
    billingAddress: z
      .object({
        line1: z.string(),
        city: z.string(),
        state: z.string().nullable(),
        postalCode: z.string(),
        country: z.string(),
      })
      .nullable()
      .default(null),
  }),
  z.object({
    type: z.literal("wallet"),
    /** `bitcoin`, `ethereum`. */
    chain: z.string(),
    /** `mainnet`, `testnet`, `signet`, or an EVM chain id. */
    network: z.string(),
    address: z.string(),
    /** Hex. Bitcoin's is also given as WIF. */
    privateKey: z.string(),
    wif: z.string().nullable().default(null),
  }),
]);
export type CardSecret = z.infer<typeof CardSecret>;

/** The file a nibblet reads its card from: the secret, and enough to know what it's for. */
export const CardFile = z.object({
  id: z.string(),
  provider: BankProviderId,
  asset: AssetCode,
  kind: CardKind,
  /** In the asset's own units, e.g. `25.00`. */
  limit: z.string(),
  purpose: z.string(),
  details: CardSecret,
});
export type CardFile = z.infer<typeof CardFile>;

/** One bank plugin the server has set up, for Settings. */
export const BankProvider = z.object({
  id: BankProviderId,
  label: z.string(),
  asset: AssetInfo,
  state: z.enum(["ready", "error"]),
  detail: z.string().nullable(),
  /** What's left to fund cards from (the treasury or funding account), when the provider says. */
  balance: MinorAmount.nullable(),
});
export type BankProvider = z.infer<typeof BankProvider>;

export const BankStatus = z.object({
  providers: z.array(BankProvider),
  /** Plugins whose settings are there but wrong, with why, so they aren't silently missing. */
  problems: z.array(z.object({ id: BankProviderId, detail: z.string() })),
});
export type BankStatus = z.infer<typeof BankStatus>;

/** Where a nibblet stands against its limit in one asset. */
export const SpendingAllowance = z.object({
  limit: SpendingLimit,
  /** Taken by the cards made this period. */
  used: MinorAmount,
  remaining: MinorAmount,
  /** When the period began. */
  since: Timestamp,
});
export type SpendingAllowance = z.infer<typeof SpendingAllowance>;

/** Parses `12.5` into minor units (`1250` for two decimals). Throws on anything else. */
export function parseAmount(text: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" isn't an amount`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`"${text}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Minor units back into the asset's own units, with trailing zeros past two places dropped. */
export function formatAmount(minor: bigint | string, decimals: number): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
