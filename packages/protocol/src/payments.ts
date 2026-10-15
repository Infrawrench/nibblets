import { z } from "zod";

/**
 * Paying for things. The person connects payment accounts on the server (a
 * Mercury account, say), each holding its own key. Each nibblet gets a
 * spending limit, monthly or all time, and per account Allow, Ask or None
 * (None unless set). Nibblets ask for cards through their tools; the server
 * issues them and writes the details to a file in the nibblet's container,
 * so a card number never passes through the API or the chat.
 *
 * Providers are plugins, grouped by kind: `card` (credit and debit cards,
 * from any number of vendors) and `crypto` (not offered yet).
 */

export const PaymentKind = z.enum(["card", "crypto"]);
export type PaymentKind = z.infer<typeof PaymentKind>;

/** What a nibblet may do with an account: use it, ask the person each time, or nothing. */
export const PaymentPermission = z.enum(["allow", "ask", "none"]);
export type PaymentPermission = z.infer<typeof PaymentPermission>;

/** Whether a nibblet's spending limit starts afresh each calendar month (UTC) or never. */
export const SpendPeriod = z.enum(["monthly", "all_time"]);
export type SpendPeriod = z.infer<typeof SpendPeriod>;

/** A field in a provider's setup form: credentials first, then the choices they unlock. */
export const SetupField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["secret", "text", "select"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  required: z.boolean().default(true),
  help: z.string().nullable().default(null),
  /** Preselected, for selects with an obvious choice. */
  default: z.string().nullable().default(null),
});
export type SetupField = z.infer<typeof SetupField>;

/** A provider the server can connect, for the "Add account" form. */
export const PaymentProviderInfo = z.object({
  id: z.string(),
  kind: PaymentKind,
  label: z.string(),
  description: z.string(),
  /** Asked for before anything else; the rest of the form comes from `payments.setup`. */
  credentialFields: z.array(SetupField),
});
export type PaymentProviderInfo = z.infer<typeof PaymentProviderInfo>;

export const PaymentAccount = z.object({
  id: z.string(),
  provider: z.string(),
  kind: PaymentKind,
  label: z.string(),
  currency: z.string(),
  /** The choices made in setup (a cardholder, where money comes from); never credentials. */
  config: z.record(z.string(), z.string()),
  /** Whether the provider answered with these credentials the last time it was asked. */
  ok: z.boolean(),
  detail: z.string().nullable(),
  /** A few lines about the account, from its provider. */
  summary: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type PaymentAccount = z.infer<typeof PaymentAccount>;

export const PaymentPolicy = z.object({
  /** The most it may have out at once, in the accounts' currency's minor units. */
  limitCents: z.int().min(0),
  period: SpendPeriod,
  /** Account id to permission; an account that isn't here is `none`. */
  access: z.record(z.string(), PaymentPermission.exclude(["none"])),
});
export type PaymentPolicy = z.infer<typeof PaymentPolicy>;

export const defaultPaymentPolicy: PaymentPolicy = { limitCents: 0, period: "monthly", access: {} };

/** `once` works for a single purchase; `recurring` holds the rest of the limit for a subscription. */
export const CardPurpose = z.enum(["once", "recurring"]);
export type CardPurpose = z.infer<typeof CardPurpose>;

/**
 * `active` can be charged. `used` was closed after its purchase (or when it
 * reached its limit), `cancelled` by the nibblet or the person, `expired`
 * because a one-time card went unused.
 */
export const CardStatus = z.enum(["active", "used", "cancelled", "expired"]);
export type CardStatus = z.infer<typeof CardStatus>;

export const IssuedCard = z.object({
  id: z.string(),
  nibbletId: z.string(),
  /** Null once the account it came from is removed. */
  accountId: z.string().nullable(),
  purpose: CardPurpose,
  /** `created` for a fresh card, `pool` for one handed out from cards the person made. */
  source: z.enum(["created", "pool"]),
  lastFour: z.string(),
  /** What the card can spend in total: its share of the nibblet's limit. */
  limitCents: z.int(),
  spentCents: z.int(),
  /** What the nibblet said it's for. */
  description: z.string(),
  status: CardStatus,
  closedReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** When an unused one-time card is cancelled. */
  expiresAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type IssuedCard = z.infer<typeof IssuedCard>;

/** One nibblet's payments: its limit and access, where it stands, and its cards. */
export const NibbletPayments = z.object({
  nibbletId: z.string(),
  policy: PaymentPolicy,
  /** Out on live cards, plus spent on closed ones, this period. */
  committedCents: z.int(),
  remainingCents: z.int(),
  /** Start of the current month for a monthly limit; null for all time. */
  periodStart: z.iso.datetime().nullable(),
  cards: z.array(IssuedCard),
});
export type NibbletPayments = z.infer<typeof NibbletPayments>;

/** Formats minor units for people and models alike: `$20.00`. */
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
