import {
  BankError,
  defineBankPlugin,
  type BankPlugin,
  type CardRef,
  type IssueRequest,
} from "@nibblet/bank";
import {
  defaultHamsterLook,
  RpcError,
  type CardFile,
  type LiveMessage,
  type Nibblet,
  type SpendingLimit,
} from "@nibblet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Bank, type BankStore } from "./bank.ts";
import type { CardRow } from "./store.ts";

function nibbletWith(id: string, spendingLimits: SpendingLimit[]): Nibblet {
  return {
    id,
    name: "Pip",
    promptName: null,
    plain: false,
    look: defaultHamsterLook,
    harness: "claude",
    model: "claude-opus-5-5",
    effort: "medium",
    instructions: "",
    parentId: null,
    status: "idle",
    statusDetail: null,
    resources: { cpus: null, memoryMb: null },
    monthlyBudgetUsd: null,
    snapshotPolicy: { everyMinutes: 1440, keep: 7 },
    heartbeats: [],
    browser: true,
    hostTools: [],
    cliCredentials: [],
    mcpServers: [],
    toolApprovals: [],
    tailscale: null,
    tailnetNode: null,
    spendingLimits,
    statusText: null,
    statusEmoji: null,
    statusUpdatedAt: null,
    awaitingApproval: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastActivityAt: null,
  };
}

/** The parts of the store the bank uses, in memory. */
class FakeStore implements BankStore {
  readonly rows = new Map<string, CardRow>();
  readonly nibblets = new Map<string, Nibblet>();
  private clock = 0;
  now = () => new Date("2026-10-21T12:00:00Z");

  async getNibblet(id: string) {
    const n = this.nibblets.get(id);
    if (!n) throw new RpcError("not_found", `No nibblet ${id}`);
    return n;
  }
  async cardsOf(nibbletId: string) {
    return [...this.rows.values()].filter((r) => r.nibbletId === nibbletId).reverse();
  }
  async liveCards() {
    return [...this.rows.values()].filter((r) => r.state !== "closed");
  }
  async deleteCard(id: string) {
    this.rows.delete(id);
  }
  async cardRow(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `No card ${id}`);
    return row;
  }
  async createCard(input: Parameters<BankStore["createCard"]>[0]) {
    const row: CardRow = {
      spentMinor: "0",
      state: "pending",
      closedBy: null,
      closedAt: null,
      checkedAt: null,
      ...input,
      createdAt: new Date(this.now().getTime() + this.clock++),
    };
    this.rows.set(row.id, row);
    return row;
  }
  async updateCard(id: string, patch: Parameters<BankStore["updateCard"]>[1]) {
    const row = { ...(await this.cardRow(id)), ...patch };
    this.rows.set(id, row);
    return row;
  }
}

/** A card issuer that keeps its cards in memory. */
class FakeIssuer {
  readonly cards = new Map<string, { open: boolean; spent: bigint; request: IssueRequest }>();
  /** The next issue is refused outright: nothing is made. */
  refuseNext = false;
  /** The next issue makes the card, then fails as if it timed out. */
  loseNext = false;
  /** The next issue fails as if it timed out, without making anything. */
  dropNext = false;
  /** Closing can't settle until this is false (a wallet whose funding isn't seen yet). */
  unsettled = false;
  /** Closing fails with an error that carries a credential. */
  leaky = false;

  plugin(): BankPlugin {
    return defineBankPlugin({
      id: "fake",
      label: "Fake issuer",
      asset: { code: "USD", decimals: 2 },
      balance: async () => 100_000n,
      issue: async (request) => {
        if (this.refuseNext) throw new BankError("the account is frozen");
        if (this.dropNext) throw new Error("timed out");
        const ref = `tok_${this.cards.size + 1}`;
        this.cards.set(ref, { open: true, spent: 0n, request });
        if (this.loseNext) throw new Error("timed out");
        return {
          ref,
          display: "•••• 4242",
          secret: {
            type: "card",
            pan: "4242424242424242",
            cvv: "123",
            expMonth: "01",
            expYear: "2031",
            billingAddress: null,
          },
        };
      },
      reveal: async () => ({
        type: "card",
        pan: "4242424242424242",
        cvv: "123",
        expMonth: "01",
        expYear: "2031",
        billingAddress: null,
      }),
      inspect: async (card: CardRef) => {
        const c = this.get(card);
        return { open: c.open, spent: c.spent, used: c.spent > 0n };
      },
      find: async (cardId) => {
        for (const [ref, c] of this.cards) {
          if (c.request.cardId === cardId) return { ref, display: "•••• 4242" };
        }
        return null;
      },
      close: async (card: CardRef) => {
        if (this.leaky) throw new Error("POST https://rpc.example/v2/SECRETKEY failed");
        const c = this.get(card);
        c.open = false;
        return { open: false, spent: c.spent, used: c.spent > 0n, settled: !this.unsettled };
      },
    });
  }

  private get(card: CardRef) {
    const c = this.cards.get(card.ref);
    if (!c) throw new Error(`no card ${card.ref}`);
    return c;
  }
}

describe("Bank", () => {
  let store: FakeStore;
  let issuer: FakeIssuer;
  let files: Map<string, CardFile>;
  let removed: string[];
  let containerUp: boolean;
  let published: LiveMessage[];
  let logs: string[];
  let clock: Date;
  let bank: Bank;

  beforeEach(() => {
    store = new FakeStore();
    store.nibblets.set(
      "nib_1",
      nibbletWith("nib_1", [{ asset: "USD", amount: "5000", period: "month" }]),
    );
    store.nibblets.set("nib_2", nibbletWith("nib_2", []));
    issuer = new FakeIssuer();
    files = new Map();
    removed = [];
    containerUp = true;
    published = [];
    logs = [];
    clock = new Date("2026-10-21T12:30:00Z");
    store.now = () => clock;
    bank = new Bank({
      store,
      plugins: new Map([["fake", issuer.plugin()]]),
      files: {
        put: async (_nibbletId, file) => {
          if (!containerUp) throw new Error("Its container isn't running");
          files.set(file.id, file);
          return `/tmp/nibblet-cards/${file.id}.json`;
        },
        remove: async (_nibbletId, cardId) => {
          removed.push(cardId);
        },
      },
      publish: (m) => published.push(m),
      log: (m) => logs.push(m),
      now: () => clock,
    });
  });

  const request = (limit: string, kind: "single_use" | "multi_use" = "single_use") =>
    bank.request("nib_1", { provider: "fake", limit, kind, purpose: "A domain" });

  it("makes a card within the limit and writes its file", async () => {
    const { card, path, details } = await request("20.00");
    expect(card).toMatchObject({ limit: "2000", state: "open", display: "•••• 4242" });
    expect(details).toBe("card");
    expect(path).toBe(`/tmp/nibblet-cards/${card.id}.json`);
    expect(files.get(card.id)).toMatchObject({
      limit: "20.00",
      details: { pan: "4242424242424242" },
    });
    expect(bank.pathOf(card.id)).toBe(path);
    expect(published).toContainEqual({ type: "cards_changed", nibbletId: "nib_1" });
    // The card's number is never stored.
    expect(JSON.stringify([...store.rows.values()])).not.toContain("4242424242424242");
  });

  it("refuses a card over what's left, counting open cards in full", async () => {
    await request("30.00");
    await expect(request("20.01")).rejects.toThrow(/over your limit: 20.00 USD is left/);
    await expect(request("20.00")).resolves.toBeTruthy();
  });

  it("refuses a nibblet without a limit in the asset", async () => {
    await expect(
      bank.request("nib_2", { provider: "fake", limit: "1", kind: "single_use", purpose: "x" }),
    ).rejects.toThrow(/no spending limit in USD/);
    expect(issuer.cards.size).toBe(0);
  });

  it("refuses an unknown bank and a bad amount", async () => {
    await expect(
      bank.request("nib_1", { provider: "nope", limit: "1", kind: "single_use", purpose: "x" }),
    ).rejects.toThrow(/No bank called nope/);
    await expect(request("1.001")).rejects.toThrow(/decimal places/);
  });

  it("doesn't let two requests at once both spend the same budget", async () => {
    const results = await Promise.allSettled([request("40.00"), request("40.00")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(issuer.cards.size).toBe(1);
  });

  it("frees what wasn't spent when a card is killed", async () => {
    const { card } = await request("50.00", "multi_use");
    await expect(request("1.00")).rejects.toThrow(/over your limit/);
    const c = issuer.cards.get("tok_1");
    if (c) c.spent = 1250n;
    const killed = await bank.kill(card.id, "nibblet", "nib_1");
    expect(killed).toMatchObject({ state: "closed", closedBy: "nibblet", spent: "1250" });
    expect(issuer.cards.get("tok_1")?.open).toBe(false);
    expect(removed).toEqual([card.id]);
    expect(bank.pathOf(card.id)).toBeNull();
    await expect(request("37.50")).resolves.toBeTruthy();
  });

  it("only lets a nibblet kill its own cards", async () => {
    const { card } = await request("5.00");
    await expect(bank.kill(card.id, "nibblet", "nib_2")).rejects.toThrow(/No card .* of yours/);
    await expect(bank.kill(card.id, "user")).resolves.toMatchObject({ closedBy: "user" });
    // Killing it again is harmless.
    await expect(bank.kill(card.id, "user")).resolves.toMatchObject({ closedBy: "user" });
  });

  it("closes a card that couldn't reach its container", async () => {
    containerUp = false;
    await expect(request("5.00")).rejects.toThrow(/couldn't be put in your container/);
    const [row] = store.rows.values();
    expect(row).toMatchObject({ state: "closed", closedBy: "server" });
    expect(issuer.cards.get("tok_1")?.open).toBe(false);
  });

  it("keeps nothing when the issuer refuses", async () => {
    issuer.refuseNext = true;
    await expect(request("5.00")).rejects.toThrow("Fake issuer refused: the account is frozen");
    expect(store.rows.size).toBe(0);
  });

  it("finds and closes a card the issuer made before failing", async () => {
    issuer.loseNext = true;
    await expect(request("30.00")).rejects.toThrow(/held as pending/);
    const [row] = store.rows.values();
    expect(row).toMatchObject({ state: "pending", ref: "" });
    // It counts against the limit while it's unknown.
    await expect(request("20.01")).rejects.toThrow(/over your limit/);
    // Too soon to look.
    await bank.sync();
    expect(issuer.cards.get("tok_1")?.open).toBe(true);
    clock = new Date(clock.getTime() + 3 * 60_000);
    await bank.sync();
    expect(store.rows.get(row?.id ?? "")).toMatchObject({
      state: "closed",
      closedBy: "server",
      ref: "tok_1",
    });
    expect(issuer.cards.get("tok_1")?.open).toBe(false);
  });

  it("forgets a pending card that was never made, after a while", async () => {
    issuer.dropNext = true;
    await expect(request("5.00")).rejects.toThrow(/held as pending/);
    clock = new Date(clock.getTime() + 5 * 60_000);
    await bank.sync();
    expect(store.rows.size).toBe(1);
    clock = new Date(clock.getTime() + 60 * 60_000);
    await bank.sync();
    expect(store.rows.size).toBe(0);
  });

  it("won't kill a card that's still pending", async () => {
    issuer.dropNext = true;
    await expect(request("5.00")).rejects.toThrow();
    const [row] = store.rows.values();
    await expect(bank.kill(row?.id ?? "", "user")).rejects.toThrow(/still being made/);
  });

  it("keeps a card closing until the provider settles it", async () => {
    const { card } = await request("20.00", "multi_use");
    issuer.unsettled = true;
    expect(await bank.kill(card.id, "nibblet", "nib_1")).toMatchObject({
      state: "closing",
      closedBy: "nibblet",
    });
    // Its file is gone at once, and it still counts in full.
    expect(removed).toContain(card.id);
    await expect(request("30.01")).rejects.toThrow(/over your limit/);
    await bank.sync();
    expect((await store.cardRow(card.id)).state).toBe("closing");
    issuer.unsettled = false;
    await bank.sync();
    expect(await store.cardRow(card.id)).toMatchObject({ state: "closed", closedBy: "nibblet" });
  });

  it("records a card closed anyway when it hasn't settled in a day", async () => {
    const { card } = await request("20.00", "multi_use");
    issuer.unsettled = true;
    await bank.kill(card.id, "user");
    clock = new Date(clock.getTime() + 25 * 60 * 60_000);
    await bank.sync();
    expect((await store.cardRow(card.id)).state).toBe("closed");
    expect(logs.join("\n")).toMatch(/never settled/);
  });

  it("gives an old card killed now a day from its killing to settle", async () => {
    const { card } = await request("20.00", "multi_use");
    clock = new Date(clock.getTime() + 2 * 24 * 60 * 60_000);
    issuer.unsettled = true;
    expect(await bank.kill(card.id, "user")).toMatchObject({ state: "closing" });
    await bank.sync();
    expect((await store.cardRow(card.id)).state).toBe("closing");
    clock = new Date(clock.getTime() + 25 * 60 * 60_000);
    await bank.sync();
    expect((await store.cardRow(card.id)).state).toBe("closed");
  });

  it("doesn't pass on a plugin's own error, which could carry a credential", async () => {
    const { card } = await request("5.00", "multi_use");
    issuer.leaky = true;
    const err = await bank.kill(card.id, "user").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(String(err)).not.toContain("SECRETKEY");
    expect(String(err)).toMatch(/server's log has the details/);
    expect(logs.join("\n")).toContain("SECRETKEY");
  });

  it("won't let a nibblet be deleted while a card can't be closed", async () => {
    await request("5.00", "multi_use");
    issuer.leaky = true;
    await expect(bank.killAll("nib_1")).rejects.toThrow(/couldn't be closed/);
    issuer.leaky = false;
    await expect(bank.killAll("nib_1")).resolves.toBeUndefined();
  });

  it("syncs spending, closes used single-use cards and notices ones the provider closed", async () => {
    const single = (await request("5.00", "single_use")).card;
    const multi = (await request("5.00", "multi_use")).card;
    const gone = (await request("5.00", "multi_use")).card;
    const at = (ref: string) => {
      const c = issuer.cards.get(ref);
      if (!c) throw new Error(ref);
      return c;
    };
    at("tok_1").spent = 499n;
    at("tok_2").spent = 100n;
    at("tok_3").open = false;
    await bank.sync();
    expect(await store.cardRow(single.id)).toMatchObject({ state: "closed", closedBy: "provider" });
    expect(at("tok_1").open).toBe(false);
    expect(await store.cardRow(multi.id)).toMatchObject({ state: "open", spentMinor: "100" });
    expect(await store.cardRow(gone.id)).toMatchObject({ state: "closed", closedBy: "provider" });
    expect(removed).toEqual(expect.arrayContaining([single.id, gone.id]));
  });

  it("writes open cards again for a container that's come back", async () => {
    const { card } = await request("5.00", "multi_use");
    const closed = (await request("5.00")).card;
    await bank.kill(closed.id, "user");
    files.clear();
    await bank.restore("nib_1");
    expect([...files.keys()]).toEqual([card.id]);
  });

  it("kills every open card of a nibblet that's being deleted", async () => {
    await request("5.00", "multi_use");
    await request("5.00", "multi_use");
    await bank.killAll("nib_1");
    expect([...store.rows.values()].every((r) => r.state === "closed")).toBe(true);
    expect([...issuer.cards.values()].every((c) => !c.open)).toBe(true);
  });

  it("says where each limit stands", async () => {
    await request("12.34", "multi_use");
    expect(await bank.allowances("nib_1")).toEqual([
      {
        limit: { asset: "USD", amount: "5000", period: "month" },
        used: "1234",
        remaining: "3766",
        since: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  it("reports each bank's balance, and banks that aren't set up right", async () => {
    const broken = new Bank({
      store,
      plugins: new Map([["fake", issuer.plugin()]]),
      errors: new Map([["slash", "SLASH_API_KEY isn't set"]]),
      files: { put: async () => "", remove: async () => {} },
      publish: () => {},
      log: () => {},
    });
    expect(await broken.status()).toEqual({
      providers: [
        {
          id: "fake",
          label: "Fake issuer",
          asset: { code: "USD", decimals: 2 },
          state: "ready",
          detail: null,
          balance: "100000",
        },
      ],
      problems: [{ id: "slash", detail: "SLASH_API_KEY isn't set" }],
    });
  });
});
