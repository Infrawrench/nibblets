import { formatMoney, type SetupField } from "@nibblet/protocol";
import { z } from "zod";
import {
  PaymentError,
  type CardDetails,
  type CardProvider,
  type CardRequest,
  type Charge,
  type IssuedProviderCard,
  type ProviderAccount,
} from "./provider.ts";

/**
 * Mercury (https://docs.mercury.com). Cards come one of two ways, set per
 * account as `cardSource`:
 *
 * - `create`: a fresh virtual card from `POST /cards`, with Mercury holding
 *   it to the amount, then its details from the Vault API.
 * - `pool`: an agent card the person made in the Mercury app, with a
 *   spending limit they chose. Mercury only reveals agent cards' numbers,
 *   and the API can't make them, so these are handed out as they are.
 * - `auto` (the default): create, and if Mercury won't reveal the new card
 *   (or won't make one), cancel it and hand out an agent card instead. A
 *   refused reveal is remembered for a day, so it doesn't create and cancel
 *   a card for every request.
 */

const HOSTS = {
  production: {
    api: "https://api.mercury.com/api/v1",
    vault: "https://vault-api.mercury.com/api/v1",
  },
  sandbox: {
    api: "https://api-sandbox.mercury.com/api/v1",
    vault: "https://vault-api-sandbox.mercury.com/api/v1",
  },
} as const;
type Environment = keyof typeof HOSTS;

const REVEAL_BLOCKED_FOR_MS = 24 * 60 * 60_000;

const Page = z.object({ nextPage: z.string().nullish() }).nullish();

const Card = z.looseObject({
  id: z.string(),
  status: z.string(),
  lastFour: z.string(),
  nameOnCard: z.string().nullish(),
  nickname: z.string().nullish(),
  isAgentCard: z.boolean().optional(),
  spendLimit: z.object({ amountCents: z.number(), interval: z.string() }).nullish(),
});
type Card = z.infer<typeof Card>;

const Reveal = z.object({
  cardNumber: z.string(),
  expiration: z.object({ month: z.number(), year: z.number() }),
  cvc: z.string(),
});

const Users = z.object({
  users: z.array(
    z.looseObject({
      userId: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string(),
      organizationRole: z.string(),
    }),
  ),
});

const Accounts = z.object({
  accounts: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      nickname: z.string().nullish(),
      kind: z.string(),
      type: z.string(),
      status: z.string(),
      accountNumber: z.string().optional(),
    }),
  ),
});

const Credit = z.object({
  accounts: z.array(z.looseObject({ id: z.string(), status: z.string() })),
});

const Transactions = z.object({
  transactions: z.array(
    z.looseObject({
      id: z.string(),
      amount: z.number(),
      status: z.string(),
      createdAt: z.string(),
      postedAt: z.string().nullish(),
      cardId: z.string().nullish(),
      counterpartyName: z.string().nullish(),
      bankDescription: z.string().nullish(),
      details: z
        .looseObject({
          debitCardInfo: z.object({ id: z.string() }).nullish(),
          creditCardInfo: z.object({ id: z.string() }).nullish(),
        })
        .nullish(),
    }),
  ),
  page: Page,
});

/** Transactions that never moved money. */
const NOT_SPENT = new Set(["failed", "cancelled", "blocked"]);

/** Statuses a card can't come back from. */
const CLOSED = new Set(["cancelled", "expired"]);

class MercuryHttpError extends PaymentError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Fetch = typeof fetch;

export interface MercuryOptions {
  fetch?: Fetch;
  now?: () => number;
}

export class MercuryProvider implements CardProvider {
  readonly id = "mercury";
  readonly kind = "card" as const;
  readonly label = "Mercury";
  readonly description =
    "Virtual debit or credit cards from a Mercury business account, using an API token.";
  readonly currency = "USD";
  readonly credentialFields: SetupField[] = [
    {
      key: "token",
      label: "API token",
      type: "secret",
      options: [],
      required: true,
      help: "Settings → API tokens in Mercury. Issuing and cancelling cards needs a Read and Write (or custom) token, and Mercury asks you to allow this server's IP address for it.",
      default: null,
    },
    {
      key: "environment",
      label: "Environment",
      type: "select",
      options: [
        { value: "production", label: "Production" },
        { value: "sandbox", label: "Sandbox" },
      ],
      required: true,
      help: null,
      default: "production",
    },
  ];

  private readonly fetch: Fetch;
  private readonly now: () => number;
  /** Accounts whose new cards Mercury wouldn't reveal, and until when to stop trying. */
  private readonly revealBlocked = new Map<string, number>();

  constructor(opts: MercuryOptions = {}) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  // Setup

  async setup(
    credentials: Record<string, string>,
    config: Record<string, string> = {},
  ): Promise<SetupField[]> {
    const [users, accounts, credit] = await Promise.all([
      this.call(credentials, "GET", "/users").then((r) => Users.parse(r)),
      this.call(credentials, "GET", "/accounts").then((r) => Accounts.parse(r)),
      // Not every organisation has credit; that's not an error.
      this.call(credentials, "GET", "/credit")
        .then((r) => Credit.parse(r))
        .catch(() => ({ accounts: [] })),
    ]);
    const admin = users.users.find((u) => u.organizationRole === "administrator");
    const checking = accounts.accounts.filter(
      (a) => a.type === "mercury" && a.status === "active" && /checking/i.test(a.kind),
    );
    const credits = credit.accounts.filter((a) => a.status === "active");
    const funding = [
      ...checking.map((a) => ({
        value: `debit:${a.id}`,
        label: `Debit from ${a.nickname || a.name}${a.accountNumber ? ` ••${a.accountNumber.slice(-4)}` : ""}`,
      })),
      ...credits.map((a, i) => ({
        value: `credit:${a.id}`,
        label: credits.length > 1 ? `Mercury credit (${i + 1})` : "Mercury credit",
      })),
    ];
    return [
      {
        key: "userId",
        label: "Cardholder",
        type: "select",
        options: users.users.map((u) => ({
          value: u.userId,
          label: `${u.firstName} ${u.lastName} (${u.email})`,
        })),
        required: true,
        help: "New cards are issued in this person's name.",
        default: config.userId ?? admin?.userId ?? users.users[0]?.userId ?? null,
      },
      {
        key: "funding",
        label: "Pay from",
        type: "select",
        options: funding,
        required: true,
        help: null,
        default: config.funding ?? funding[0]?.value ?? null,
      },
      {
        key: "cardSource",
        label: "Cards",
        type: "select",
        options: [
          { value: "auto", label: "New cards, falling back to my agent cards" },
          { value: "create", label: "Only new cards" },
          { value: "pool", label: "Only agent cards I made in Mercury" },
        ],
        required: true,
        help: "Mercury only shows card numbers to the API for agent cards, which you make in the Mercury app with a spending limit. Nibblets hands those out when it can't use a new card.",
        default: config.cardSource ?? "auto",
      },
      {
        key: "poolFilter",
        label: "Agent cards named",
        type: "text",
        options: [],
        required: false,
        help: "Only hand out agent cards whose nickname contains this. Leave empty for any.",
        default: config.poolFilter ?? null,
      },
    ];
  }

  async describe(account: ProviderAccount) {
    try {
      const pool = await this.agentCards(account);
      const source = account.config.cardSource ?? "auto";
      const summary = [
        source === "pool"
          ? "Hands out agent cards you made in Mercury"
          : source === "create"
            ? "Issues new virtual cards"
            : "Issues new virtual cards, or hands out your agent cards",
        `${pool.length} agent card${pool.length === 1 ? "" : "s"} with a limit available`,
      ];
      if (source === "auto" && this.isRevealBlocked(account.id)) {
        summary.push(
          "Mercury didn't show a new card's number recently, so agent cards are used for now",
        );
      }
      return { ok: true, detail: null, summary };
    } catch (err) {
      return { ok: false, detail: message(err), summary: [] };
    }
  }

  // Cards

  async issue(account: ProviderAccount, request: CardRequest): Promise<IssuedProviderCard> {
    const source = account.config.cardSource ?? "auto";
    let fallback: string | null = null;
    if (source === "create" || (source === "auto" && !this.isRevealBlocked(account.id))) {
      try {
        return await this.create(account, request);
      } catch (err) {
        if (source === "create") throw err;
        fallback = message(err);
      }
    }
    const card = await this.fromPool(account, request, fallback);
    return fallback
      ? { ...card, note: `Handed out an agent card, because a new card didn't work: ${fallback}` }
      : card;
  }

  async reveal(account: ProviderAccount, ref: string): Promise<CardDetails> {
    const body = Reveal.parse(
      await this.call(account.credentials, "GET", `/cards/${encodeURIComponent(ref)}/reveal`, {
        vault: true,
      }),
    );
    const card = Card.safeParse(
      await this.call(account.credentials, "GET", `/cards/${encodeURIComponent(ref)}`).catch(
        () => null,
      ),
    );
    return {
      number: body.cardNumber,
      expMonth: body.expiration.month,
      expYear: body.expiration.year,
      cvc: body.cvc,
      nameOnCard: card.success ? (card.data.nameOnCard ?? null) : null,
    };
  }

  async cancel(account: ProviderAccount, ref: string): Promise<void> {
    try {
      await this.call(account.credentials, "POST", `/cards/${encodeURIComponent(ref)}/cancel`);
    } catch (err) {
      // Already gone (cancelled, expired, deleted in the dashboard) is what we wanted.
      if (err instanceof MercuryHttpError && err.status === 404) return;
      const card = await this.call(account.credentials, "GET", `/cards/${encodeURIComponent(ref)}`)
        .then((r) => Card.parse(r))
        .catch(() => null);
      if (card && CLOSED.has(card.status)) return;
      throw err;
    }
  }

  async charges(account: ProviderAccount, refs: string[], since: Date): Promise<Charge[]> {
    if (refs.length === 0) return [];
    const wanted = new Set(refs);
    const out: Charge[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ start: since.toISOString().slice(0, 10), limit: "1000" });
      for (const ref of refs) query.append("cardId", ref);
      if (after) query.set("start_after", after);
      const body = Transactions.parse(
        await this.call(account.credentials, "GET", `/transactions?${query.toString()}`),
      );
      for (const t of body.transactions) {
        const cardRef = t.cardId ?? t.details?.debitCardInfo?.id ?? t.details?.creditCardInfo?.id;
        if (!cardRef || !wanted.has(cardRef) || NOT_SPENT.has(t.status)) continue;
        out.push({
          ref: t.id,
          cardRef,
          // Mercury gives money out as negative amounts; a charge is positive here.
          amountCents: Math.round(-t.amount * 100),
          description: t.counterpartyName ?? t.bankDescription ?? "",
          at: new Date(t.postedAt ?? t.createdAt),
        });
      }
      after = body.page?.nextPage ?? null;
      if (!after) break;
    }
    return out;
  }

  // Internals

  private isRevealBlocked(accountId: string): boolean {
    const until = this.revealBlocked.get(accountId);
    return until !== undefined && until > this.now();
  }

  private async create(account: ProviderAccount, request: CardRequest) {
    const [kind, fundingId] = (account.config.funding ?? "").split(":");
    if ((kind !== "debit" && kind !== "credit") || !fundingId) {
      throw new PaymentError("Choose where this Mercury account's cards are paid from in Settings");
    }
    if (!account.config.userId) throw new PaymentError("Choose a cardholder in Settings");
    const card = Card.parse(
      await this.call(account.credentials, "POST", "/cards", {
        body: {
          userId: account.config.userId,
          type: "virtual",
          kind,
          accountId: fundingId,
          nickname: request.nickname.slice(0, 50),
          spendLimit: { amountCents: request.amountCents, interval: request.interval },
        },
      }),
    );
    let details: CardDetails;
    try {
      details = await this.reveal(account, card.id);
    } catch (err) {
      // A card nobody can see is no use, and shouldn't be left open.
      await this.cancel(account, card.id).catch(() => undefined);
      if (err instanceof MercuryHttpError && err.status >= 400 && err.status < 500) {
        this.revealBlocked.set(account.id, this.now() + REVEAL_BLOCKED_FOR_MS);
        throw new PaymentError(
          "Mercury made the card but won't show its number to the API (it only does that for agent cards made in the Mercury app), so it was cancelled",
        );
      }
      throw err;
    }
    // Revealing works, so stop steering this account to agent cards.
    this.revealBlocked.delete(account.id);
    return {
      ref: card.id,
      lastFour: card.lastFour,
      limitCents: request.amountCents,
      source: "created" as const,
      details,
    };
  }

  /** Active agent cards with a spending limit, matching the account's name filter. */
  private async agentCards(account: ProviderAccount): Promise<(Card & { limit: number })[]> {
    const filter = account.config.poolFilter?.trim().toLowerCase() ?? "";
    const cards: (Card & { limit: number })[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ isAgentCard: "true", status: "active", limit: "500" });
      if (after) query.set("start_after", after);
      const body = z
        .object({ cards: z.array(Card), page: Page })
        .parse(await this.call(account.credentials, "GET", `/cards?${query.toString()}`));
      for (const card of body.cards) {
        if (card.status !== "active" || card.isAgentCard === false || !card.spendLimit) continue;
        if (filter && !(card.nickname ?? "").toLowerCase().includes(filter)) continue;
        cards.push({ ...card, limit: card.spendLimit.amountCents });
      }
      after = body.page?.nextPage ?? null;
      if (!after) break;
    }
    return cards;
  }

  private async fromPool(
    account: ProviderAccount,
    request: CardRequest,
    why: string | null,
  ): Promise<IssuedProviderCard> {
    const free = (await this.agentCards(account)).filter((c) => !request.inUse.has(c.id));
    // The smallest card that covers the request, so as little as possible is held.
    const fits = free
      .filter((c) => c.limit >= request.amountCents && c.limit <= request.maxCents)
      .sort((a, b) => a.limit - b.limit);
    const card = fits[0];
    if (!card) {
      const range =
        request.amountCents === request.maxCents
          ? `of exactly ${formatMoney(request.amountCents)}`
          : `between ${formatMoney(request.amountCents)} and ${formatMoney(request.maxCents)}`;
      throw new PaymentError(
        `${why ? `${why}. ` : ""}There's no free agent card in Mercury with a spending limit ${range}${
          free.length ? ` (${free.length} free, none in range)` : ""
        }. Make one in the Mercury app under Cards, or raise this nibblet's limit.`,
      );
    }
    return {
      ref: card.id,
      lastFour: card.lastFour,
      limitCents: card.limit,
      source: "pool",
      details: await this.reveal(account, card.id),
    };
  }

  private async call(
    credentials: Record<string, string>,
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; vault?: boolean } = {},
  ): Promise<unknown> {
    const env: Environment = credentials.environment === "sandbox" ? "sandbox" : "production";
    const token = (credentials.token ?? "").trim();
    if (!token) throw new PaymentError("Add a Mercury API token");
    const base = opts.vault ? HOSTS[env].vault : HOSTS[env].api;
    let res: Response;
    try {
      res = await this.fetch(`${base}${path}`, {
        method,
        headers: {
          // Tokens are shown with this prefix; people often copy them without it.
          authorization: `Bearer ${token.startsWith("secret-token:") ? token : `secret-token:${token}`}`,
          accept: "application/json",
          ...(opts.body ? { "content-type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new PaymentError(`Couldn't reach Mercury: ${message(err)}`);
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    throw new MercuryHttpError(res.status, mercuryMessage(res.status, text));
  }
}

/** Mercury's own words when it gives them, else what the status means. */
function mercuryMessage(status: number, body: string): string {
  let said = "";
  try {
    const parsed: unknown = JSON.parse(body);
    const found = z
      .union([
        z.object({ errors: z.object({ message: z.string() }) }),
        z.object({ message: z.string() }),
        z.object({ error: z.string() }),
      ])
      .safeParse(parsed);
    if (found.success) {
      const d = found.data;
      said = "errors" in d ? d.errors.message : "message" in d ? d.message : d.error;
    }
  } catch {
    said = body.slice(0, 200);
  }
  const meaning =
    status === 401
      ? "Mercury didn't accept the API token"
      : status === 403
        ? "The API token isn't allowed to do this (it may need write access, or this server's IP address allowed)"
        : status === 404
          ? "Mercury couldn't find that"
          : status === 429
            ? "Mercury is rate limiting requests; try again shortly"
            : `Mercury answered ${status}`;
  return said ? `${meaning}: ${said}` : meaning;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
