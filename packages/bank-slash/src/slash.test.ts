import { BankError } from "@nibblet/bank";
import { describe, expect, it } from "vitest";
import { slash, slashPlugin, SLASH_API } from "./index.ts";

interface Call {
  method: string;
  url: URL;
  key: string | null;
  body: unknown;
}

interface StoredCard {
  id: string;
  status: string;
  spent: number;
  body: Record<string, unknown>;
}

/** A Slash that keeps cards in memory, enough for the plugin's calls. */
function fakeSlash(opts: { hidePan?: boolean; failCreate?: number } = {}) {
  const calls: Call[] = [];
  const cards = new Map<string, StoredCard>();
  const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
  const view = (c: StoredCard, withNumber: boolean) => ({
    id: c.id,
    accountId: "acc_1",
    last4: "4242",
    status: c.status,
    expiryMonth: "08",
    expiryYear: "2031",
    isPhysical: false,
    name: c.body.name,
    userData: c.body.userData,
    ...(withNumber && !opts.hidePan ? { pan: "4111111111114242", cvv: "321" } : {}),
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, key: new Headers(init?.headers).get("x-api-key"), body });
    const path = url.pathname;
    if (method === "POST" && path === "/card") {
      if (opts.failCreate) return reply(opts.failCreate, { message: "Account is frozen" });
      const id = `card_s${cards.size + 1}`;
      const record =
        typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {};
      cards.set(id, { id, status: "active", spent: 0, body: record });
      return reply(200, view(cards.get(id) ?? { id, status: "", spent: 0, body: {} }, false));
    }
    if (method === "GET" && path === "/card") {
      const items = [...cards.values()].reverse().map((c) => view(c, false));
      return reply(200, { items, metadata: {} });
    }
    if (path === "/account/acc_1/balance") {
      return reply(200, {
        balances: [
          { accountId: "acc_1", available: { amountCents: 123456 }, posted: { amountCents: 0 } },
        ],
      });
    }
    const used = /^\/card\/([^/]+)\/utilization$/.exec(path);
    if (used?.[1]) {
      const c = cards.get(used[1]);
      return c
        ? reply(200, { spend: { amountCents: c.spent } })
        : reply(404, { message: "Not found" });
    }
    const one = /^\/card\/([^/]+)$/.exec(path);
    if (one?.[1]) {
      const c = cards.get(one[1]);
      if (!c) return reply(404, { message: "Card not found" });
      if (method === "PATCH" && typeof body === "object" && body && "status" in body) {
        c.status = String(body.status);
      }
      return reply(200, view(c, url.searchParams.get("include_pan") === "true"));
    }
    return reply(404, { message: `No route ${method} ${path}` });
  };
  return { fetch, calls, cards };
}

const request = {
  cardId: "card_1",
  nibbletId: "nib_1",
  label: "Pip: domain",
  kind: "single_use" as const,
  limit: 2500n,
};

describe("slash", () => {
  it("issues a single-use card with a lifetime limit in cents", async () => {
    const api = fakeSlash();
    const plugin = slashPlugin({ apiKey: "key_1", accountId: "acc_1" }, api);
    const card = await plugin.issue(request);
    expect(card).toEqual({
      ref: "card_s1",
      display: "•••• 4242",
      secret: {
        type: "card",
        pan: "4111111111114242",
        cvv: "321",
        expMonth: "08",
        expYear: "2031",
        billingAddress: null,
      },
    });
    const [create, reveal] = api.calls;
    expect(create).toMatchObject({ method: "POST", key: "key_1" });
    expect(create?.url.href).toBe(`${SLASH_API}/card`);
    expect(create?.body).toEqual({
      type: "virtual",
      name: "Pip: domain",
      isSingleUse: true,
      accountId: "acc_1",
      userData: { nibbletCard: "card_1", nibblet: "nib_1" },
      spendingConstraint: {
        spendingRule: {
          utilizationLimit: { preset: "collective", limitAmount: { amountCents: 2500 } },
        },
      },
    });
    expect(reveal?.url.search).toBe("?include_pan=true&include_cvv=true");
  });

  it("makes a multi-use card that isn't single use", async () => {
    const api = fakeSlash();
    await slashPlugin({ apiKey: "k" }, api).issue({ ...request, kind: "multi_use" });
    expect(api.calls[0]?.body).toMatchObject({ isSingleUse: false });
    expect(api.calls[0]?.body).not.toHaveProperty("accountId");
  });

  it("reads a refusal as nothing made, and a server error as unclear", async () => {
    const refused = slashPlugin({ apiKey: "k" }, fakeSlash({ failCreate: 403 }));
    const err = await refused.issue(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BankError);
    expect(String(err)).toContain("Slash: Account is frozen");
    const down = slashPlugin({ apiKey: "k" }, fakeSlash({ failCreate: 502 }));
    const unclear = await down.issue(request).catch((e: unknown) => e);
    expect(unclear).toBeInstanceOf(Error);
    expect(unclear).not.toBeInstanceOf(BankError);
  });

  it("closes a card again when Slash won't hand over its number", async () => {
    const api = fakeSlash({ hidePan: true });
    const plugin = slashPlugin({ apiKey: "k" }, api);
    await expect(plugin.issue(request)).rejects.toThrow(/cards.view/);
    expect(api.cards.get("card_s1")?.status).toBe("closed");
  });

  it("finds a card it made by the id it was tagged with", async () => {
    const api = fakeSlash();
    const plugin = slashPlugin({ apiKey: "k", accountId: "acc_1" }, api);
    await plugin.issue(request);
    await plugin.issue({ ...request, cardId: "card_2" });
    expect(await plugin.find("card_1")).toEqual({ ref: "card_s1", display: "•••• 4242" });
    expect(await plugin.find("card_9")).toBeNull();
    const list = api.calls.find((c) => c.method === "GET" && c.url.pathname === "/card");
    expect(list?.url.searchParams.get("filter:accountId")).toBe("acc_1");
  });

  it("reports what's spent, and closes", async () => {
    const api = fakeSlash();
    const plugin = slashPlugin({ apiKey: "k" }, api);
    const { ref } = await plugin.issue({ ...request, kind: "multi_use" });
    const card = { id: "card_1", ref, kind: "multi_use" as const, limit: 2500n };
    expect(await plugin.inspect(card)).toEqual({ open: true, spent: 0n, used: false });
    const stored = api.cards.get(ref);
    if (stored) stored.spent = 1999;
    expect(await plugin.inspect(card)).toEqual({ open: true, spent: 1999n, used: true });
    expect(await plugin.close(card)).toEqual({
      open: false,
      spent: 1999n,
      used: true,
      settled: true,
    });
    expect(api.cards.get(ref)?.status).toBe("closed");
    const patches = () => api.calls.filter((c) => c.method === "PATCH").length;
    const before = patches();
    await plugin.close(card);
    expect(patches()).toBe(before);
  });

  it("notices a single-use card Slash closed itself", async () => {
    const api = fakeSlash();
    const plugin = slashPlugin({ apiKey: "k" }, api);
    const { ref } = await plugin.issue(request);
    const stored = api.cards.get(ref);
    if (stored) {
      stored.spent = 2500;
      stored.status = "closed";
    }
    expect(await plugin.inspect({ id: "card_1", ref, kind: "single_use", limit: 2500n })).toEqual({
      open: false,
      spent: 2500n,
      used: true,
    });
  });

  it("reads the account's balance when it knows the account", async () => {
    expect(await slashPlugin({ apiKey: "k", accountId: "acc_1" }, fakeSlash()).balance()).toBe(
      123456n,
    );
    expect(await slashPlugin({ apiKey: "k" }, fakeSlash()).balance()).toBeNull();
  });

  it("turns on from its settings, and only then", () => {
    const deps = { fetch: globalThis.fetch, log: () => {} };
    expect(slash.fromEnv({}, deps)).toBeNull();
    expect(slash.fromEnv({ SLASH_API_KEY: "k" }, deps)?.label).toBe("Slash");
    expect(() =>
      slash.fromEnv({ SLASH_API_KEY: "k", SLASH_BASE_URL: "http://plain.example" }, deps),
    ).toThrow(/https/);
  });
});
