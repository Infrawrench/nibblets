import { defaultPaymentPolicy, type LiveMessage, type PaymentPolicy } from "@nibblet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../approvals.ts";
import { Payments, type PaymentsGateway } from "./payments.ts";
import { PaymentError, type CardProvider, type CardRequest, type Charge } from "./provider.ts";
import { PaymentRegistry } from "./registry.ts";
import type { AccountRow, CardRow, ChargeRow, PaymentsRepo } from "./repo.ts";

class MemoryRepo implements PaymentsRepo {
  accountRows: AccountRow[] = [];
  cardRows: CardRow[] = [];
  chargeRows: ChargeRow[] = [];
  policyRows = new Map<string, PaymentPolicy>();

  async accounts() {
    return this.accountRows;
  }
  async account(id: string) {
    return this.accountRows.find((a) => a.id === id) ?? null;
  }
  async insertAccount(row: Omit<AccountRow, "createdAt">) {
    const out = { ...row, createdAt: new Date() };
    this.accountRows.push(out);
    return out;
  }
  async updateAccount(id: string, patch: Partial<AccountRow>) {
    const row = this.accountRows.find((a) => a.id === id);
    if (!row) throw new Error("no account");
    Object.assign(row, patch);
    return row;
  }
  async deleteAccount(id: string) {
    this.accountRows = this.accountRows.filter((a) => a.id !== id);
    for (const c of this.cardRows) if (c.accountId === id) c.accountId = null;
  }
  async policy(nibbletId: string) {
    return this.policyRows.get(nibbletId) ?? defaultPaymentPolicy;
  }
  async setPolicy(nibbletId: string, policy: PaymentPolicy) {
    this.policyRows.set(nibbletId, policy);
  }
  async policies() {
    return [...this.policyRows].map(([nibbletId, policy]) => ({ nibbletId, policy }));
  }
  async cards(nibbletId: string) {
    return this.cardRows.filter((c) => c.nibbletId === nibbletId);
  }
  async card(id: string) {
    return this.cardRows.find((c) => c.id === id) ?? null;
  }
  async watchedCards() {
    return [...this.cardRows];
  }
  async activeRefs(provider: string) {
    return new Set(
      this.cardRows
        .filter((c) => c.provider === provider && c.status === "active")
        .map((c) => c.providerRef),
    );
  }
  async insertCard(row: Omit<CardRow, "createdAt"> & { createdAt?: Date }) {
    const out = { ...row, createdAt: row.createdAt ?? new Date() };
    this.cardRows.push(out);
    return out;
  }
  async updateCard(id: string, patch: Partial<CardRow>) {
    const row = this.cardRows.find((c) => c.id === id);
    if (!row) throw new Error("no card");
    Object.assign(row, patch);
    return { ...row };
  }
  async charges(cardIds: string[]) {
    return this.chargeRows.filter((c) => cardIds.includes(c.cardId));
  }
  async upsertCharges(rows: ChargeRow[]) {
    for (const row of rows) {
      this.chargeRows = this.chargeRows.filter(
        (c) => !(c.cardId === row.cardId && c.ref === row.ref),
      );
      this.chargeRows.push(row);
    }
  }
}

class FakeCards implements CardProvider {
  readonly id = "fakebank";
  readonly kind = "card" as const;
  readonly label = "Fake Bank";
  readonly description = "";
  readonly currency = "USD";
  readonly credentialFields = [
    {
      key: "token",
      label: "Token",
      type: "secret" as const,
      options: [],
      required: true,
      help: null,
      default: null,
    },
  ];
  issued: CardRequest[] = [];
  cancelled: string[] = [];
  charged: Charge[] = [];
  failCancel = false;

  async setup() {
    return [
      {
        key: "holder",
        label: "Cardholder",
        type: "select" as const,
        options: [{ value: "me", label: "Me" }],
        required: true,
        help: null,
        default: "me",
      },
    ];
  }
  async describe() {
    return { ok: true, detail: null, summary: [] };
  }
  async issue(_account: unknown, request: CardRequest) {
    this.issued.push(request);
    const n = this.issued.length;
    return {
      ref: `ref-${n}`,
      lastFour: `000${n}`,
      limitCents: request.amountCents,
      source: "created" as const,
      details: {
        number: "4242424242424242",
        expMonth: 1,
        expYear: 2030,
        cvc: "999",
        nameOnCard: null,
      },
    };
  }
  async reveal() {
    return { number: "4242424242424242", expMonth: 1, expYear: 2030, cvc: "999", nameOnCard: null };
  }
  async cancel(_account: unknown, ref: string) {
    if (this.failCancel) throw new Error("bank down");
    this.cancelled.push(ref);
  }
  async charges(_account: unknown, refs: string[]) {
    return this.charged.filter((c) => refs.includes(c.cardRef));
  }
}

const NIB = "nib_1";

describe("payments", () => {
  let repo: MemoryRepo;
  let bank: FakeCards;
  let payments: Payments;
  let files: Map<string, string>;
  let asked: { tool: string; input: unknown }[];
  let answer: Decision;
  let now: Date;
  let accountId: string;

  beforeEach(async () => {
    repo = new MemoryRepo();
    bank = new FakeCards();
    files = new Map();
    asked = [];
    answer = { approved: true, reason: null };
    now = new Date("2026-05-10T12:00:00Z");
    const gateway: PaymentsGateway = {
      approve: async (_id, call) => {
        asked.push({ tool: call.tool, input: call.input });
        return answer;
      },
      writeSecret: async (_id, name, content) => {
        if (content === null) {
          files.delete(name);
          return null;
        }
        files.set(name, content);
        return `/secrets/${name}`;
      },
      notice: async () => {},
      publish: (_m: LiveMessage) => {},
    };
    payments = new Payments(repo, new PaymentRegistry([bank]), gateway, {
      now: () => now,
      log: () => {},
    });
    accountId = (
      await payments.addAccount({
        provider: "fakebank",
        label: "Ops",
        credentials: { token: "t" },
        config: {},
      })
    ).id;
  });

  const allow = (
    permission: "allow" | "ask",
    limitCents = 10_000,
    period: "monthly" | "all_time" = "monthly",
  ) =>
    payments.setPolicy({ nibbletId: NIB, limitCents, period, access: { [accountId]: permission } });

  it("refuses everything until an account is allowed", async () => {
    await payments.setPolicy({ nibbletId: NIB, limitCents: 10_000 });
    await expect(
      payments.requestCard(NIB, { purpose: "once", amountCents: 500, description: "domain" }),
    ).rejects.toThrow(/haven't been given any card accounts/);
    expect(bank.issued).toHaveLength(0);
  });

  it("issues a one-time card within the limit and writes its details to a file", async () => {
    await allow("allow");
    const { card, path } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 2000,
      description: "domain renewal",
    });
    expect(card).toMatchObject({ purpose: "once", limitCents: 2000, lastFour: "0001" });
    expect(path).toBe(`/secrets/${card.id}.json`);
    expect(JSON.parse(files.get(`${card.id}.json`) ?? "{}")).toMatchObject({
      number: "4242424242424242",
      expiry: "01/30",
      cvc: "999",
    });
    expect(asked).toHaveLength(0);
    expect((await payments.overview(NIB)).remainingCents).toBe(8000);
  });

  it("won't go over what's left", async () => {
    await allow("allow", 3000);
    await payments.requestCard(NIB, { purpose: "once", amountCents: 2000, description: "a" });
    await expect(
      payments.requestCard(NIB, { purpose: "once", amountCents: 1500, description: "b" }),
    ).rejects.toThrow(/more than you have left: \$10\.00/);
  });

  it("gives a recurring card the rest of the limit, with the card's own limit monthly", async () => {
    await allow("allow", 5000);
    await payments.requestCard(NIB, { purpose: "once", amountCents: 1000, description: "a" });
    const { card } = await payments.requestCard(NIB, {
      purpose: "recurring",
      description: "hosting",
    });
    expect(card.limitCents).toBe(4000);
    expect(bank.issued[1]?.interval).toBe("monthly");
    await expect(
      payments.requestCard(NIB, { purpose: "recurring", description: "more" }),
    ).rejects.toThrow(/nothing left/);
  });

  it("asks first where the account is set to Ask, and stops when declined", async () => {
    await allow("ask");
    answer = { approved: false, reason: "too pricey" };
    await expect(
      payments.requestCard(NIB, { purpose: "once", amountCents: 2000, description: "gadget" }),
    ).rejects.toThrow(/too pricey/);
    expect(asked[0]).toMatchObject({
      tool: "card_once",
      input: { amount: "$20.00", for: "gadget" },
    });
    expect(bank.issued).toHaveLength(0);

    answer = { approved: true, reason: null };
    await payments.requestCard(NIB, { purpose: "once", amountCents: 2000, description: "gadget" });
    // A card the person approved can't come out bigger than what they saw.
    expect(bank.issued[0]?.maxCents).toBe(2000);
  });

  it("deleting a card cancels it, removes its file and frees its limit", async () => {
    await allow("allow", 3000);
    const { card } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 3000,
      description: "a",
    });
    const deleted = await payments.deleteCard(NIB, card.id);
    expect(deleted.status).toBe("cancelled");
    expect(bank.cancelled).toEqual(["ref-1"]);
    expect(files.has(`${card.id}.json`)).toBe(false);
    expect((await payments.overview(NIB)).remainingCents).toBe(3000);
    await expect(payments.deleteCard("nib_other", card.id)).rejects.toThrow(PaymentError);
  });

  it("keeps a card open (and counted) when the bank can't cancel it", async () => {
    await allow("allow", 3000);
    const { card } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 3000,
      description: "a",
    });
    bank.failCancel = true;
    await expect(payments.deleteCard(NIB, card.id)).rejects.toThrow(/bank down/);
    expect((await payments.overview(NIB)).remainingCents).toBe(0);
  });

  it("closes a one-time card after its first charge and a grace period, counting what it spent", async () => {
    await allow("allow", 5000);
    const { card } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 2000,
      description: "a",
    });
    bank.charged.push({
      ref: "tx1",
      cardRef: "ref-1",
      amountCents: 1899,
      description: "Shop",
      at: now,
    });
    await payments.poll();
    expect((await repo.card(card.id))?.status).toBe("active");

    now = new Date(now.getTime() + 20 * 60_000);
    await payments.poll();
    const closed = await repo.card(card.id);
    expect(closed).toMatchObject({ status: "used" });
    const o = await payments.overview(NIB);
    expect(o.committedCents).toBe(1899);
    expect(o.cards[0]?.spentCents).toBe(1899);
  });

  it("closes a one-time card nobody used once it expires", async () => {
    await allow("allow");
    const { card } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 500,
      description: "a",
      validDays: 2,
    });
    now = new Date(now.getTime() + 3 * 86_400_000);
    await payments.poll();
    expect((await repo.card(card.id))?.status).toBe("expired");
  });

  it("closes a recurring card on an all-time limit once it has spent its share", async () => {
    await allow("allow", 3000, "all_time");
    const { card } = await payments.requestCard(NIB, {
      purpose: "recurring",
      description: "hosting",
    });
    expect(bank.issued[0]?.interval).toBe("yearly");
    bank.charged.push(
      { ref: "a", cardRef: "ref-1", amountCents: 1500, description: "", at: now },
      { ref: "b", cardRef: "ref-1", amountCents: 1500, description: "", at: now },
    );
    await payments.poll();
    expect((await repo.card(card.id))?.status).toBe("used");
  });

  it("starts a monthly limit afresh each month, but not an all-time one", async () => {
    await allow("allow", 3000);
    const { card } = await payments.requestCard(NIB, {
      purpose: "once",
      amountCents: 3000,
      description: "a",
    });
    bank.charged.push({ ref: "x", cardRef: "ref-1", amountCents: 3000, description: "", at: now });
    now = new Date(now.getTime() + 30 * 60_000);
    await payments.poll();
    expect((await repo.card(card.id))?.status).toBe("used");
    expect((await payments.overview(NIB)).remainingCents).toBe(0);

    now = new Date("2026-06-02T00:00:00Z");
    expect((await payments.overview(NIB)).remainingCents).toBe(3000);
    await payments.setPolicy({ nibbletId: NIB, period: "all_time" });
    expect((await payments.overview(NIB)).remainingCents).toBe(0);
  });

  it("removing an account cancels its cards and takes it away from nibblets", async () => {
    await allow("allow");
    await payments.requestCard(NIB, { purpose: "once", amountCents: 500, description: "a" });
    await payments.removeAccount(accountId);
    expect(bank.cancelled).toEqual(["ref-1"]);
    expect((await repo.policy(NIB)).access).toEqual({});
  });

  it("checks setup choices against what the provider offered", async () => {
    await expect(
      payments.addAccount({
        provider: "fakebank",
        label: "x",
        credentials: { token: "t" },
        config: { holder: "someone" },
      }),
    ).rejects.toThrow(/isn't one of the choices/);
    await expect(
      payments.addAccount({ provider: "fakebank", label: "x", credentials: {}, config: {} }),
    ).rejects.toThrow(/Token is needed/);
  });
});
