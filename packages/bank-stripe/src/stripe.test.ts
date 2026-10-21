import { BankError } from "@nibblet/bank";
import { describe, expect, it } from "vitest";
import { stripe, stripePlugin, STRIPE_API, STRIPE_VERSION } from "./index.ts";

interface Call {
  method: string;
  url: URL;
  auth: string | null;
  version: string | null;
  body: URLSearchParams | null;
}

interface StoredCard {
  id: string;
  status: string;
  metadata: Record<string, string>;
  /** Captures (negative) and refunds (positive). */
  transactions: number[];
  /** Authorisations not yet captured. */
  pending: number[];
}

const cardholder = {
  id: "ich_1",
  object: "issuing.cardholder",
  status: "active",
  billing: {
    address: {
      line1: "1 Main St",
      line2: "Suite 2",
      city: "San Francisco",
      state: "CA",
      postal_code: "94111",
      country: "US",
    },
  },
};

/** A Stripe that keeps Issuing cards in memory, enough for the plugin's calls. */
function fakeStripe(opts: { hideNumber?: boolean; failCreate?: number; holder?: string } = {}) {
  const calls: Call[] = [];
  const cards = new Map<string, StoredCard>();
  const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
  const view = (c: StoredCard, withNumber: boolean) => ({
    id: c.id,
    object: "issuing.card",
    last4: "4242",
    status: c.status,
    exp_month: 8,
    exp_year: 2031,
    currency: "usd",
    type: "virtual",
    metadata: c.metadata,
    cardholder: { ...cardholder, status: opts.holder ?? "active" },
    ...(withNumber && !opts.hideNumber ? { number: "4000009990000006", cvc: "321" } : {}),
  });
  const list = (items: { id: string }[], q: URLSearchParams) => {
    const after = q.get("starting_after");
    const from = after ? items.findIndex((i) => i.id === after) + 1 : 0;
    const limit = Number(q.get("limit") ?? 10);
    const data = items.slice(from, from + limit);
    return reply(200, { object: "list", data, has_more: from + limit < items.length });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    calls.push({ method, url, auth, version: headers.get("stripe-version"), body });
    if (auth === "Bearer sk_test_wrong") {
      return reply(401, {
        error: {
          type: "invalid_request_error",
          message: "Invalid API Key provided: sk_test_*rong",
        },
      });
    }
    const path = url.pathname;
    const q = url.searchParams;
    if (method === "POST" && path === "/v1/issuing/cards") {
      if (opts.failCreate) {
        return reply(opts.failCreate, { error: { message: "Your account can't issue cards" } });
      }
      const id = `ic_${cards.size + 1}`;
      const metadata: Record<string, string> = {};
      for (const [k, v] of body ?? []) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m?.[1]) metadata[m[1]] = v;
      }
      const card = { id, status: "active", metadata, transactions: [], pending: [] };
      cards.set(id, card);
      return reply(200, view(card, false));
    }
    if (method === "GET" && path === "/v1/issuing/cards") {
      return list(
        [...cards.values()].reverse().map((c) => view(c, false)),
        q,
      );
    }
    if (path === "/v1/issuing/cardholders/ich_1") {
      return reply(200, { ...cardholder, status: opts.holder ?? "active" });
    }
    if (path === "/v1/balance") {
      return reply(200, {
        object: "balance",
        available: [{ amount: 1, currency: "usd" }],
        issuing: {
          available: [
            { amount: 123456, currency: "usd" },
            { amount: 999, currency: "eur" },
          ],
        },
      });
    }
    if (path === "/v1/issuing/transactions" || path === "/v1/issuing/authorizations") {
      const card = cards.get(q.get("card") ?? "");
      const amounts =
        path === "/v1/issuing/transactions" ? (card?.transactions ?? []) : (card?.pending ?? []);
      return list(
        amounts.map((amount, i) => ({ id: `${path.slice(-5)}_${i}`, amount })),
        q,
      );
    }
    const one = /^\/v1\/issuing\/cards\/([^/]+)$/.exec(path);
    if (one?.[1]) {
      const c = cards.get(one[1]);
      if (!c) return reply(404, { error: { message: `No such issuing card: '${one[1]}'` } });
      if (method === "POST" && body?.get("status")) c.status = body.get("status") ?? c.status;
      const expand = [q.get("expand[0]"), q.get("expand[1]")];
      return reply(200, view(c, expand.includes("number") && expand.includes("cvc")));
    }
    return reply(404, { error: { message: `Unrecognized request URL (${method}: ${path})` } });
  };
  return { fetch, calls, cards };
}

const options = { apiKey: "sk_test_1", cardholderId: "ich_1" };

const request = {
  cardId: "card_1",
  nibbletId: "nib_1",
  label: "Pip: domain",
  kind: "single_use" as const,
  limit: 2500n,
};

describe("stripe", () => {
  it("issues a virtual card with a lifetime limit, and the cardholder's address", async () => {
    const api = fakeStripe();
    const card = await stripePlugin(options, api).issue(request);
    expect(card).toEqual({
      ref: "ic_1",
      display: "•••• 4242",
      secret: {
        type: "card",
        pan: "4000009990000006",
        cvv: "321",
        expMonth: "08",
        expYear: "2031",
        billingAddress: {
          line1: "1 Main St, Suite 2",
          city: "San Francisco",
          state: "CA",
          postalCode: "94111",
          country: "US",
        },
      },
    });
    const [create, reveal] = api.calls;
    expect(create).toMatchObject({
      method: "POST",
      auth: "Bearer sk_test_1",
      version: STRIPE_VERSION,
    });
    expect(create?.url.href).toBe(`${STRIPE_API}/v1/issuing/cards`);
    expect(Object.fromEntries(create?.body ?? [])).toEqual({
      cardholder: "ich_1",
      currency: "usd",
      type: "virtual",
      status: "active",
      "metadata[nibbletCard]": "card_1",
      "metadata[nibblet]": "nib_1",
      "metadata[label]": "Pip: domain",
      "spending_controls[spending_limits][0][amount]": "2500",
      "spending_controls[spending_limits][0][interval]": "all_time",
    });
    expect(reveal?.url.search).toBe("?expand%5B0%5D=number&expand%5B1%5D=cvc");
  });

  it("makes cards in the currency it's set up with", async () => {
    const api = fakeStripe();
    const plugin = stripePlugin({ ...options, currency: "eur" }, api);
    expect(plugin.asset).toEqual({ code: "EUR", decimals: 2 });
    await plugin.issue(request);
    expect(api.calls[0]?.body?.get("currency")).toBe("eur");
    expect(await plugin.balance()).toBe(999n);
  });

  it("reads a refusal as nothing made, and a server error as unclear", async () => {
    const refused = stripePlugin(options, fakeStripe({ failCreate: 400 }));
    const err = await refused.issue(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
    expect(String(err)).toContain("Stripe: Your account can't issue cards");
    const down = stripePlugin(options, fakeStripe({ failCreate: 500 }));
    const unclear = await down.issue(request).catch((e: unknown) => e);
    expect(unclear).toBeInstanceOf(Error);
    expect(unclear).not.toBeInstanceOf(BankError);
  });

  it("cancels a card again when Stripe won't hand over its number", async () => {
    const api = fakeStripe({ hideNumber: true });
    await expect(stripePlugin(options, api).issue(request)).rejects.toThrow(/card's number/);
    expect(api.cards.get("ic_1")?.status).toBe("canceled");
  });

  it("finds a card it made by the id in its metadata, a page at a time", async () => {
    const api = fakeStripe();
    const plugin = stripePlugin(options, api);
    await plugin.issue(request);
    for (let i = 2; i <= 150; i++) {
      api.cards.set(`ic_x${i}`, {
        id: `ic_x${i}`,
        status: "active",
        metadata: {},
        transactions: [],
        pending: [],
      });
    }
    expect(await plugin.find("card_1")).toEqual({ ref: "ic_1", display: "•••• 4242" });
    expect(await plugin.find("card_9")).toBeNull();
    const lists = api.calls.filter(
      (c) => c.method === "GET" && c.url.pathname === "/v1/issuing/cards",
    );
    expect(lists[0]?.url.searchParams.get("cardholder")).toBe("ich_1");
    expect(lists[1]?.url.searchParams.get("starting_after")).toBeTruthy();
  });

  it("counts captures net of refunds, and holds, as spent; and cancels", async () => {
    const api = fakeStripe();
    const plugin = stripePlugin(options, api);
    const { ref } = await plugin.issue({ ...request, kind: "multi_use" });
    const card = { id: "card_1", ref, kind: "multi_use" as const, limit: 2500n };
    expect(await plugin.inspect(card)).toEqual({ open: true, spent: 0n, used: false });
    const stored = api.cards.get(ref);
    if (stored) {
      stored.transactions = [-1500, -300, 100];
      stored.pending = [400];
    }
    expect(await plugin.inspect(card)).toEqual({ open: true, spent: 2100n, used: true });
    expect(await plugin.close(card)).toEqual({
      open: false,
      spent: 2100n,
      used: true,
      settled: true,
    });
    expect(api.cards.get(ref)?.status).toBe("canceled");
    const posts = () => api.calls.filter((c) => c.method === "POST").length;
    const before = posts();
    await plugin.close(card);
    expect(posts()).toBe(before);
  });

  it("reports a single-use card used once anything's gone through it, refunded or not", async () => {
    const api = fakeStripe();
    const plugin = stripePlugin(options, api);
    const { ref } = await plugin.issue(request);
    const stored = api.cards.get(ref);
    if (stored) stored.transactions = [-500, 500];
    expect(await plugin.inspect({ id: "card_1", ref, kind: "single_use", limit: 2500n })).toEqual({
      open: true,
      spent: 0n,
      used: true,
    });
  });

  it("reads the Issuing balance in its currency", async () => {
    expect(await stripePlugin(options, fakeStripe()).balance()).toBe(123456n);
  });

  it("checks its key and cardholder with Stripe before it's saved", async () => {
    await expect(stripePlugin(options, fakeStripe()).check()).resolves.toBeUndefined();
    const refused = stripePlugin({ ...options, apiKey: "sk_test_wrong" }, fakeStripe()).check();
    await expect(refused).rejects.toBeInstanceOf(BankError);
    await expect(refused).rejects.toThrow("Stripe: Invalid API Key provided");
    await expect(
      stripePlugin({ ...options, cardholderId: "ich_2" }, fakeStripe()).check(),
    ).rejects.toThrow(/No such|Unrecognized/);
    await expect(stripePlugin(options, fakeStripe({ holder: "inactive" })).check()).rejects.toThrow(
      "the cardholder is inactive",
    );
    const down = stripePlugin(options, {
      fetch: async () => {
        throw new Error("fetch failed");
      },
    });
    await expect(down.check()).rejects.toThrow("Couldn't reach Stripe: fetch failed");
  });

  it("turns on from its settings, and only then", () => {
    const deps = { fetch: globalThis.fetch, log: () => {} };
    const settings = { STRIPE_API_KEY: "rk_live_1", STRIPE_CARDHOLDER_ID: "ich_1" };
    expect(stripe.fromSettings({}, deps)).toBeNull();
    expect(stripe.fromSettings(settings, deps)?.label).toBe("Stripe");
    expect(stripe.fromSettings({ ...settings, STRIPE_API_KEY: "sk_test_1" }, deps)?.label).toBe(
      "Stripe (test mode)",
    );
    expect(stripe.fromSettings({ ...settings, STRIPE_CURRENCY: "GBP" }, deps)?.asset.code).toBe(
      "GBP",
    );
    expect(() => stripe.fromSettings({ STRIPE_API_KEY: "sk_test_1" }, deps)).toThrow(
      "Cardholder ID is needed",
    );
    expect(() => stripe.fromSettings({ ...settings, STRIPE_API_KEY: "pk_live_1" }, deps)).toThrow(
      /sk_/,
    );
    expect(() => stripe.fromSettings({ ...settings, STRIPE_CARDHOLDER_ID: "cus_1" }, deps)).toThrow(
      /ich_/,
    );
    expect(() => stripe.fromSettings({ ...settings, STRIPE_CURRENCY: "jpy" }, deps)).toThrow(
      /usd, eur, gbp/,
    );
  });
});
