import {
  BankError,
  defineBankFactory,
  defineBankPlugin,
  defineField,
  maskedCard,
  optionalSetting,
  requireSetting,
  type BankDeps,
  type BankPlugin,
  type BankSettingValues,
  type CardRef,
  type CardUsage,
} from "@nibblet/bank";
import type { CardSecret } from "@nibblet/protocol";
import { z } from "zod";

/**
 * Virtual cards from Stripe Issuing, on the person's own Stripe account, for
 * one cardholder they've made there. Each card carries an `all_time`
 * spending limit of the card's limit, so Stripe declines anything over it
 * whatever the server thinks. Stripe has no single-use cards, so a
 * single-use one is reported used after its first purchase and the server
 * closes it; cancelling a card at Stripe is for good.
 *
 * Settings (see `fields`): a secret or restricted key that can manage
 * Issuing cards, the cardholder cards are made for (whose billing address
 * the nibblet is given), and the currency of the account's Issuing balance.
 */

export const STRIPE_API = "https://api.stripe.com";

/** The API version the shapes below are for, rather than the account's default. */
export const STRIPE_VERSION = "2026-09-30.endive";

/** How many pages of recent cards `find` looks through. */
const FIND_PAGES = 3;

const CURRENCIES = ["usd", "eur", "gbp"] as const;
type Currency = (typeof CURRENCIES)[number];
const isCurrency = (value: string): value is Currency => CURRENCIES.some((c) => c === value);

const Address = z.object({
  line1: z.string(),
  line2: z.string().nullable().optional(),
  city: z.string(),
  state: z.string().nullable().optional(),
  postal_code: z.string(),
  country: z.string(),
});

const Cardholder = z.object({
  id: z.string(),
  status: z.string(),
  billing: z.object({ address: Address }),
});

const StripeCard = z.object({
  id: z.string(),
  last4: z.string(),
  status: z.enum(["active", "inactive", "canceled"]),
  exp_month: z.number(),
  exp_year: z.number(),
  number: z.string().optional(),
  cvc: z.string().optional(),
  metadata: z.record(z.string(), z.string()),
  cardholder: Cardholder,
});
type StripeCard = z.infer<typeof StripeCard>;

const List = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), has_more: z.boolean() });

const CardList = List(StripeCard);
const Amounts = List(z.object({ id: z.string(), amount: z.number() }));

const Balance = z.object({
  issuing: z
    .object({ available: z.array(z.object({ amount: z.number(), currency: z.string() })) })
    .optional(),
});

const ErrorBody = z.object({ error: z.object({ message: z.string() }) });

/**
 * Stripe said no. Its own messages are safe to show (it masks keys in
 * them), and a refused request made nothing.
 */
export class StripeError extends BankError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Stripe: ${message}`);
    this.status = status;
  }
}

export interface StripeOptions {
  apiKey: string;
  cardholderId: string;
  currency?: Currency;
}

/** A whole number of cents for Stripe. */
function cents(amount: bigint): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BankError("That's more than a card can hold");
  }
  return Number(amount);
}

/** Stripe's form encoding: `a[b][0][c]=v`. */
function encode(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    } else out.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return out;
}

export function stripePlugin(options: StripeOptions, deps: Pick<BankDeps, "fetch">): BankPlugin {
  const currency = options.currency ?? "usd";

  async function call(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const encoded = encode(params).toString();
    const query = method === "GET" && encoded ? `?${encoded}` : "";
    const res = await deps.fetch(`${STRIPE_API}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "stripe-version": STRIPE_VERSION,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(method === "POST" ? { body: encoded } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; the status says enough.
    }
    if (res.status >= 400 && res.status < 500) {
      const error = ErrorBody.safeParse(parsed);
      throw new StripeError(
        res.status,
        error.success ? error.data.error.message : `HTTP ${res.status}`,
      );
    }
    // A server error leaves it unclear whether anything happened.
    if (!res.ok) throw new Error(`Stripe: HTTP ${res.status} for ${method} ${path}`);
    return parsed;
  }

  const cardPath = (id: string) => `/v1/issuing/cards/${encodeURIComponent(id)}`;

  const getCard = async (id: string, withNumber = false) =>
    StripeCard.parse(
      await call("GET", cardPath(id), withNumber ? { expand: ["number", "cvc"] } : {}),
    );

  /** Every page of a list, summed. */
  async function total(path: string, params: Record<string, unknown>) {
    let sum = 0;
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const page = Amounts.parse(
        await call("GET", path, { ...params, limit: 100, starting_after: after }),
      );
      for (const item of page.data) sum += item.amount;
      count += page.data.length;
      after = page.data.at(-1)?.id;
      if (!page.has_more || !after) return { sum, count };
    }
  }

  function secret(card: StripeCard): CardSecret {
    if (!card.number || !card.cvc) {
      throw new BankError(
        "Stripe didn't send the card's number. Check that the API key can read Issuing cards.",
      );
    }
    const address = card.cardholder.billing.address;
    return {
      type: "card",
      pan: card.number,
      cvv: card.cvc,
      expMonth: String(card.exp_month).padStart(2, "0"),
      expYear: String(card.exp_year),
      billingAddress: {
        line1: address.line2 ? `${address.line1}, ${address.line2}` : address.line1,
        city: address.city,
        state: address.state || null,
        postalCode: address.postal_code,
        country: address.country,
      },
    };
  }

  async function usage(card: CardRef): Promise<CardUsage> {
    const [state, settled, held] = await Promise.all([
      getCard(card.ref),
      // Captures are negative and refunds positive, in the card's currency.
      total("/v1/issuing/transactions", { card: card.ref }),
      // What's authorised but not yet captured is as good as spent. One
      // that's been partly captured counts twice until it closes, which
      // only makes the card look fuller than it is.
      total("/v1/issuing/authorizations", { card: card.ref, status: "pending" }),
    ]);
    const spent = BigInt(Math.max(0, -settled.sum) + Math.max(0, held.sum));
    return {
      open: state.status !== "canceled",
      spent,
      used: spent > 0n || settled.count > 0 || held.count > 0,
    };
  }

  async function balance(): Promise<bigint | null> {
    const { issuing } = Balance.parse(await call("GET", "/v1/balance"));
    if (!issuing) return null;
    return issuing.available
      .filter((b) => b.currency === currency)
      .reduce((sum, b) => sum + BigInt(b.amount), 0n);
  }

  const cancel = (id: string) => call("POST", cardPath(id), { status: "canceled" });

  return defineBankPlugin({
    id: "stripe",
    label: options.apiKey.includes("_test_") ? "Stripe (test mode)" : "Stripe",
    asset: { code: currency.toUpperCase(), decimals: 2 },
    instrument: "card",
    fundAt: null,

    async check() {
      try {
        const holder = Cardholder.parse(
          await call("GET", `/v1/issuing/cardholders/${encodeURIComponent(options.cardholderId)}`),
        );
        if (holder.status !== "active") {
          throw new BankError(
            `Stripe: the cardholder is ${holder.status}, and cards can only be made for an active one`,
          );
        }
      } catch (err) {
        if (err instanceof BankError) throw err;
        throw new BankError(
          `Couldn't reach Stripe: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    balance,

    async issue(request) {
      const made = StripeCard.parse(
        await call("POST", "/v1/issuing/cards", {
          cardholder: options.cardholderId,
          currency,
          type: "virtual",
          status: "active",
          // So `find` can tell which card is which.
          metadata: {
            nibbletCard: request.cardId,
            nibblet: request.nibbletId,
            label: request.label.slice(0, 500),
          },
          spending_controls: {
            spending_limits: [{ amount: cents(request.limit), interval: "all_time" }],
          },
        }),
      );
      try {
        return {
          ref: made.id,
          display: maskedCard(made.last4),
          secret: secret(await getCard(made.id, true)),
        };
      } catch (err) {
        // A card nobody can use shouldn't stay open. If it can't be
        // cancelled, the error mustn't read as "nothing was made": the
        // server then finds the card and closes it later.
        const cancelled = await cancel(made.id).then(
          () => true,
          () => false,
        );
        if (cancelled) throw err;
        throw new Error(`Stripe card ${made.id} couldn't be used or cancelled: ${String(err)}`);
      }
    },

    async find(cardId) {
      let after: string | undefined;
      for (let page = 0; page < FIND_PAGES; page++) {
        const list = CardList.parse(
          await call("GET", "/v1/issuing/cards", {
            cardholder: options.cardholderId,
            type: "virtual",
            limit: 100,
            starting_after: after,
          }),
        );
        const card = list.data.find((c) => c.metadata.nibbletCard === cardId);
        if (card) return { ref: card.id, display: maskedCard(card.last4) };
        after = list.data.at(-1)?.id;
        if (!list.has_more || !after) break;
      }
      return null;
    },

    async reveal(card) {
      return secret(await getCard(card.ref, true));
    },

    inspect: usage,

    async close(card) {
      const current = await getCard(card.ref);
      if (current.status !== "canceled") await cancel(card.ref);
      return { ...(await usage(card)), open: false, settled: true };
    },
  });
}

const API_KEY = defineField("STRIPE_API_KEY", "API key", {
  required: true,
  secret: true,
  placeholder: "sk_live_… or rk_live_…",
  hint: "A secret key, or a restricted key with write access to Issuing cards and read access to Issuing cardholders, authorizations and transactions, and balances.",
});
const CARDHOLDER_ID = defineField("STRIPE_CARDHOLDER_ID", "Cardholder ID", {
  required: true,
  placeholder: "ich_…",
  hint: "The Issuing cardholder cards are made for. Make one in Stripe's dashboard; its billing address goes with each card.",
});
const CURRENCY = defineField("STRIPE_CURRENCY", "Currency", {
  lockedByCards: true,
  options: [
    { value: "usd", label: "US dollars" },
    { value: "eur", label: "Euros" },
    { value: "gbp", label: "Pounds sterling" },
  ],
  hint: "Your Issuing balance's currency. US dollars if it's blank.",
});

export const stripe = defineBankFactory({
  id: "stripe",
  name: "Stripe",
  about: "Virtual cards from Stripe Issuing, on your Stripe account.",
  instrument: "card",
  fields: [API_KEY, CARDHOLDER_ID, CURRENCY],
  fromSettings(settings: BankSettingValues, deps: BankDeps) {
    if (!optionalSetting(settings, API_KEY)) return null;
    const apiKey = requireSetting(settings, API_KEY);
    if (!/^(sk|rk)_(live|test)_/.test(apiKey)) {
      throw new Error(`${API_KEY.label} should be a secret (sk_) or restricted (rk_) key`);
    }
    const cardholderId = requireSetting(settings, CARDHOLDER_ID);
    if (!cardholderId.startsWith("ich_")) {
      throw new Error(`${CARDHOLDER_ID.label} should start with ich_`);
    }
    const currency = optionalSetting(settings, CURRENCY)?.toLowerCase();
    if (currency !== undefined && !isCurrency(currency)) {
      throw new Error(`${CURRENCY.label} should be one of ${CURRENCIES.join(", ")}`);
    }
    return stripePlugin({ apiKey, cardholderId, ...(currency ? { currency } : {}) }, deps);
  },
});
