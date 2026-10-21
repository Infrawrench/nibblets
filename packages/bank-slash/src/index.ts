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
} from "@nibblets/bank";
import type { CardSecret } from "@nibblets/protocol";
import { z } from "zod";

/**
 * Virtual cards from Slash (slash.com), in US dollars, on the person's own
 * Slash account. A single-use card is Slash's own `isSingleUse`, which Slash
 * closes after the first authorisation; a multi-use one stays open until
 * it's killed. Both carry a `collective` utilisation limit (one that never
 * resets) of the card's limit, so Slash declines anything over it whatever
 * the server thinks.
 *
 * Settings (see `fields`): an API key with the cards.view and cards.manage
 * permissions, and optionally the account cards are made under, and whose
 * balance Settings shows (Slash picks the first commercial account
 * otherwise), and another API URL.
 */

export const SLASH_API = "https://api.joinslash.com";

/** How many pages of recent cards `find` looks through. */
const FIND_PAGES = 3;

const Money = z.object({ amountCents: z.number() });

const SlashCard = z.object({
  id: z.string(),
  last4: z.string(),
  status: z.enum(["active", "paused", "inactive", "closed"]),
  expiryMonth: z.string(),
  expiryYear: z.string(),
  pan: z.string().optional(),
  cvv: z.string().optional(),
  userData: z.unknown().optional(),
});
type SlashCard = z.infer<typeof SlashCard>;

const CardList = z.object({
  items: z.array(SlashCard),
  metadata: z.object({ nextCursor: z.string().optional() }).optional(),
});

const Utilization = z.object({ spend: Money });

const Balances = z.object({ balances: z.array(z.object({ available: Money })) });

const ErrorBody = z.union([z.object({ message: z.string() }), z.object({ error: z.string() })]);

/** The card id the server tagged a Slash card with, if it has one. */
const Tagged = z.object({ userData: z.object({ nibbletCard: z.string() }) });

/**
 * Slash said no. Its own messages are safe to show, and a refused request
 * made nothing.
 */
export class SlashError extends BankError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Slash: ${message}`);
    this.status = status;
  }
}

export interface SlashOptions {
  apiKey: string;
  accountId?: string;
  baseUrl?: string;
}

/** A whole number of cents for Slash, which takes them as a JSON number. */
function cents(amount: bigint): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BankError("That's more than a card can hold");
  }
  return Number(amount);
}

export function slashPlugin(options: SlashOptions, deps: Pick<BankDeps, "fetch">): BankPlugin {
  const base = (options.baseUrl ?? SLASH_API).replace(/\/+$/, "");

  async function call(method: string, path: string, body?: object): Promise<unknown> {
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": options.apiKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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
      const said = error.success
        ? "message" in error.data
          ? error.data.message
          : error.data.error
        : `HTTP ${res.status}`;
      throw new SlashError(res.status, said);
    }
    // A server error leaves it unclear whether anything happened.
    if (!res.ok) throw new Error(`Slash: HTTP ${res.status} for ${method} ${path}`);
    return parsed;
  }

  const getCard = async (id: string, withNumber = false) =>
    SlashCard.parse(
      await call(
        "GET",
        `/card/${encodeURIComponent(id)}${withNumber ? "?include_pan=true&include_cvv=true" : ""}`,
      ),
    );

  function secret(card: SlashCard): CardSecret {
    if (!card.pan || !card.cvv) {
      throw new BankError(
        "Slash didn't send the card's number. The API key needs the cards.view permission to hand it over.",
      );
    }
    return {
      type: "card",
      pan: card.pan,
      cvv: card.cvv,
      expMonth: card.expiryMonth,
      expYear: card.expiryYear,
      billingAddress: null,
    };
  }

  async function usage(card: CardRef): Promise<CardUsage> {
    const id = encodeURIComponent(card.ref);
    const [state, used] = await Promise.all([
      getCard(card.ref),
      call("GET", `/card/${id}/utilization`).then((v) => Utilization.parse(v)),
    ]);
    const spent = BigInt(Math.max(0, Math.round(used.spend.amountCents)));
    return { open: state.status !== "closed", spent, used: spent > 0n };
  }

  async function balance(): Promise<bigint | null> {
    if (!options.accountId) return null;
    const { balances } = Balances.parse(
      await call("GET", `/account/${encodeURIComponent(options.accountId)}/balance`),
    );
    return balances.reduce((sum, b) => sum + BigInt(Math.round(b.available.amountCents)), 0n);
  }

  const closeAt = (id: string) =>
    call("PATCH", `/card/${encodeURIComponent(id)}`, { status: "closed" });

  return defineBankPlugin({
    id: "slash",
    label: "Slash",
    asset: { code: "USD", decimals: 2 },
    instrument: "card",
    fundAt: null,

    async check() {
      try {
        if (options.accountId) await balance();
        else CardList.parse(await call("GET", "/card?sort=createdAt&sortDirection=DESC"));
      } catch (err) {
        if (err instanceof BankError) throw err;
        throw new BankError(
          `Couldn't reach Slash: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    balance,

    async issue(request) {
      const made = SlashCard.parse(
        await call("POST", "/card", {
          type: "virtual",
          name: request.label,
          isSingleUse: request.kind === "single_use",
          ...(options.accountId ? { accountId: options.accountId } : {}),
          // So `find` can tell which card is which.
          userData: { nibbletCard: request.cardId, nibblet: request.nibbletId },
          spendingConstraint: {
            spendingRule: {
              utilizationLimit: {
                preset: "collective",
                limitAmount: { amountCents: cents(request.limit) },
              },
            },
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
        // A card nobody can use shouldn't stay open. If it can't be closed,
        // the error mustn't read as "nothing was made": the server then
        // finds the card and closes it later.
        const closed = await closeAt(made.id).then(
          () => true,
          () => false,
        );
        if (closed) throw err;
        throw new Error(`Slash card ${made.id} couldn't be used or closed: ${String(err)}`);
      }
    },

    async find(cardId) {
      let cursor: string | undefined;
      for (let page = 0; page < FIND_PAGES; page++) {
        const query = new URLSearchParams({ sort: "createdAt", sortDirection: "DESC" });
        if (options.accountId) query.set("filter:accountId", options.accountId);
        if (cursor) query.set("cursor", cursor);
        const list = CardList.parse(await call("GET", `/card?${query}`));
        for (const card of list.items) {
          const tagged = Tagged.safeParse(card);
          if (tagged.success && tagged.data.userData.nibbletCard === cardId) {
            return { ref: card.id, display: maskedCard(card.last4) };
          }
        }
        cursor = list.metadata?.nextCursor;
        if (!cursor) break;
      }
      return null;
    },

    async reveal(card) {
      return secret(await getCard(card.ref, true));
    },

    inspect: usage,

    async close(card) {
      const current = await getCard(card.ref);
      if (current.status !== "closed") await closeAt(card.ref);
      return { ...(await usage(card)), open: false, settled: true };
    },
  });
}

const API_KEY = defineField("SLASH_API_KEY", "API key", {
  required: true,
  secret: true,
  hint: "Make one in Slash's dashboard, with the cards.view and cards.manage permissions.",
});
const ACCOUNT_ID = defineField("SLASH_ACCOUNT_ID", "Account ID", {
  hint: "The account cards are made under, and whose balance shows here. Slash picks your first commercial account if it's blank.",
});
const BASE_URL = defineField("SLASH_BASE_URL", "API URL", {
  placeholder: SLASH_API,
  hint: "Only to point at another Slash API, such as a sandbox.",
});

export const slash = defineBankFactory({
  id: "slash",
  name: "Slash",
  about: "Virtual cards in US dollars, on your Slash business account.",
  instrument: "card",
  fields: [API_KEY, ACCOUNT_ID, BASE_URL],
  fromSettings(settings: BankSettingValues, deps: BankDeps) {
    if (!optionalSetting(settings, API_KEY)) return null;
    const baseUrl = optionalSetting(settings, BASE_URL);
    if (baseUrl && !/^https:\/\//.test(baseUrl)) {
      throw new Error(`${BASE_URL.label} should be an https URL`);
    }
    const accountId = optionalSetting(settings, ACCOUNT_ID);
    return slashPlugin(
      {
        apiKey: requireSetting(settings, API_KEY),
        ...(accountId ? { accountId } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      },
      deps,
    );
  },
});
