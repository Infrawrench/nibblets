import { describe, expect, it } from "vitest";
import { MercuryProvider } from "./mercury.ts";
import type { CardRequest, ProviderAccount } from "./provider.ts";

interface FakeCard {
  id: string;
  status: string;
  lastFour: string;
  nickname?: string;
  isAgentCard: boolean;
  spendLimit: { amountCents: number; interval: string } | null;
}

/** A small Mercury: cards, reveals (for agent cards only, like the real one), transactions. */
function fakeMercury(opts: { agentCards?: FakeCard[]; revealAnything?: boolean } = {}) {
  const cards = new Map<string, FakeCard>((opts.agentCards ?? []).map((c) => [c.id, c]));
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      method,
      url: url.toString(),
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (method === "POST" && path === "/cards") {
      const id = `new-${++n}`;
      cards.set(id, {
        id,
        status: "active",
        lastFour: `100${n}`,
        isAgentCard: false,
        spendLimit: body.spendLimit,
      });
      return json({ ...cards.get(id), nameOnCard: "Astrid Gealer" });
    }
    let m = /^\/cards\/([^/]+)\/reveal$/.exec(path);
    if (m?.[1]) {
      const card = cards.get(m[1]);
      if (!url.hostname.startsWith("vault-api")) return json({ message: "wrong host" }, 404);
      if (!card) return json({ message: "not found" }, 404);
      if (!card.isAgentCard && !opts.revealAnything)
        return json({ errors: { message: "Only agent cards can be revealed" } }, 403);
      return json({
        cardNumber: `4242424242${card.lastFour.padStart(6, "0")}`,
        expiration: { month: 7, year: 2029 },
        cvc: "123",
      });
    }
    m = /^\/cards\/([^/]+)\/cancel$/.exec(path);
    if (m?.[1] && method === "POST") {
      const card = cards.get(m[1]);
      if (!card) return json({ message: "not found" }, 404);
      card.status = "cancelled";
      return json(card);
    }
    m = /^\/cards\/([^/]+)$/.exec(path);
    if (m?.[1]) {
      const card = cards.get(m[1]);
      return card ? json({ ...card, nameOnCard: "Astrid Gealer" }) : json({}, 404);
    }
    if (path === "/cards") {
      const list = [...cards.values()].filter(
        (c) => c.isAgentCard && url.searchParams.get("status") === c.status,
      );
      return json({ cards: list, page: {} });
    }
    if (path === "/transactions") {
      const wanted = url.searchParams.getAll("cardId");
      const all = [
        {
          id: "t1",
          amount: -12.5,
          status: "sent",
          createdAt: "2026-05-02T10:00:00Z",
          postedAt: "2026-05-03T10:00:00Z",
          cardId: "new-1",
          counterpartyName: "Namecheap",
        },
        {
          id: "t2",
          amount: 4,
          status: "sent",
          createdAt: "2026-05-04T10:00:00Z",
          cardId: "new-1",
          counterpartyName: "Namecheap refund",
        },
        {
          id: "t3",
          amount: -99,
          status: "failed",
          createdAt: "2026-05-04T10:00:00Z",
          cardId: "new-1",
        },
        {
          id: "t4",
          amount: -7,
          status: "pending",
          createdAt: "2026-05-04T10:00:00Z",
          details: { debitCardInfo: { id: "other" } },
        },
      ];
      return json({
        transactions: all.filter(
          (t) => !t.cardId || wanted.includes(t.cardId) || wanted.includes("other"),
        ),
        page: {},
      });
    }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { fetch, calls, cards };
}

const account = (config: Record<string, string> = {}): ProviderAccount => ({
  id: "pay_1",
  label: "Ops",
  credentials: { token: "abc123", environment: "production" },
  config: { userId: "u1", funding: "debit:acct-1", cardSource: "auto", ...config },
});

const request = (over: Partial<CardRequest> = {}): CardRequest => ({
  purpose: "once",
  amountCents: 2000,
  maxCents: 10_000,
  interval: "yearly",
  nickname: "Nibblet one-time: domain",
  inUse: new Set(),
  ...over,
});

const agentCard = (id: string, limit: number, nickname = ""): FakeCard => ({
  id,
  status: "active",
  lastFour: id.slice(-4).padStart(4, "0"),
  nickname,
  isAgentCard: true,
  spendLimit: { amountCents: limit, interval: "monthly" },
});

describe("Mercury cards", () => {
  it("creates a card held to the amount and reveals it through the vault", async () => {
    const mercury = fakeMercury({ revealAnything: true });
    const provider = new MercuryProvider({ fetch: mercury.fetch });
    const card = await provider.issue(account(), request());
    expect(card).toMatchObject({ source: "created", limitCents: 2000, lastFour: "1001" });
    expect(card.details).toMatchObject({
      cvc: "123",
      expMonth: 7,
      expYear: 2029,
      nameOnCard: "Astrid Gealer",
    });
    const create = mercury.calls.find((c) => c.method === "POST" && c.url.endsWith("/cards"));
    expect(create?.body).toMatchObject({
      userId: "u1",
      type: "virtual",
      kind: "debit",
      accountId: "acct-1",
      spendLimit: { amountCents: 2000, interval: "yearly" },
    });
    // Mercury shows tokens with a prefix that people often leave off.
    expect(create?.auth).toBe("Bearer secret-token:abc123");
  });

  it("cancels a new card Mercury won't reveal, falls back to the smallest agent card that fits, and remembers", async () => {
    const mercury = fakeMercury({
      agentCards: [
        agentCard("ag-big", 9000),
        agentCard("ag-small", 2500),
        agentCard("ag-tiny", 1000),
      ],
    });
    const provider = new MercuryProvider({ fetch: mercury.fetch });
    const card = await provider.issue(account(), request());
    expect(card).toMatchObject({ source: "pool", ref: "ag-small", limitCents: 2500 });
    expect(card.note).toMatch(/agent card/);
    expect(mercury.cards.get("new-1")?.status).toBe("cancelled");

    // The next request goes straight to the pool rather than creating another card.
    const posts = mercury.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/cards"),
    ).length;
    const next = await provider.issue(account(), request({ inUse: new Set(["ag-small"]) }));
    expect(next.ref).toBe("ag-big");
    expect(
      mercury.calls.filter((c) => c.method === "POST" && c.url.endsWith("/cards")).length,
    ).toBe(posts);
  });

  it("only creates in create mode, and says why it can't", async () => {
    const mercury = fakeMercury({ agentCards: [agentCard("ag-1", 2000)] });
    const provider = new MercuryProvider({ fetch: mercury.fetch });
    await expect(provider.issue(account({ cardSource: "create" }), request())).rejects.toThrow(
      /won't show its number/,
    );
    expect(mercury.cards.get("new-1")?.status).toBe("cancelled");
  });

  it("hands out only agent cards in range, matching the name filter, in pool mode", async () => {
    const mercury = fakeMercury({
      agentCards: [agentCard("ag-a", 3000, "Personal"), agentCard("ag-b", 4000, "Nibblets 1")],
    });
    const provider = new MercuryProvider({ fetch: mercury.fetch });
    const card = await provider.issue(
      account({ cardSource: "pool", poolFilter: "nibblets" }),
      request(),
    );
    expect(card.ref).toBe("ag-b");
    expect(mercury.calls.some((c) => c.method === "POST")).toBe(false);
    await expect(
      provider.issue(account({ cardSource: "pool" }), request({ maxCents: 2500 })),
    ).rejects.toThrow(/between \$20\.00 and \$25\.00/);
  });

  it("reads charges as positive, refunds as negative, and skips ones that failed", async () => {
    const mercury = fakeMercury();
    const provider = new MercuryProvider({ fetch: mercury.fetch });
    const charges = await provider.charges(account(), ["new-1"], new Date("2026-05-01T00:00:00Z"));
    expect(charges.map((c) => [c.ref, c.amountCents])).toEqual([
      ["t1", 1250],
      ["t2", -400],
    ]);
    expect(charges[0]?.at).toEqual(new Date("2026-05-03T10:00:00Z"));
  });

  it("treats a card that's already gone as cancelled", async () => {
    const provider = new MercuryProvider({ fetch: fakeMercury().fetch });
    await expect(provider.cancel(account(), "missing")).resolves.toBeUndefined();
  });
});
