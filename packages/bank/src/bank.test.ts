import { formatAmount, parseAmount, type CardSecret } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import {
  allowance,
  checkCard,
  defineBankFactory,
  defineBankPlugin,
  deriveWalletKey,
  loadBankPlugins,
  periodStart,
  requireEnv,
  type BankPlugin,
  type BudgetCard,
} from "./index.ts";

const secret: CardSecret = {
  type: "card",
  pan: "4111111111111111",
  cvv: "123",
  expMonth: "01",
  expYear: "2030",
  billingAddress: null,
};

function fakePlugin(id: string): BankPlugin {
  return defineBankPlugin({
    id,
    label: id,
    asset: { code: "USD", decimals: 2 },
    balance: async () => null,
    issue: async () => ({ ref: "r", display: "•••• 1111", secret }),
    find: async () => null,
    reveal: async () => secret,
    inspect: async () => ({ open: true, spent: 0n, used: false }),
    close: async () => ({ open: false, spent: 0n, used: false, settled: true }),
  });
}

const deps = { fetch: globalThis.fetch, log: () => {} };

describe("amounts", () => {
  it("parses into minor units", () => {
    expect(parseAmount("12.5", 2)).toBe(1250n);
    expect(parseAmount("12", 2)).toBe(1200n);
    expect(parseAmount("0.001", 8)).toBe(100000n);
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("7", 0)).toBe(7n);
  });

  it("refuses what isn't an amount", () => {
    expect(() => parseAmount("-1", 2)).toThrow();
    expect(() => parseAmount("1.234", 2)).toThrow(/decimal places/);
    expect(() => parseAmount("1e3", 2)).toThrow();
    expect(() => parseAmount("", 2)).toThrow();
  });

  it("formats back", () => {
    expect(formatAmount(1250n, 2)).toBe("12.50");
    expect(formatAmount("5", 2)).toBe("0.05");
    expect(formatAmount(100000n, 8)).toBe("0.001");
    expect(formatAmount(10n ** 18n, 18)).toBe("1.00");
    expect(formatAmount(7n, 0)).toBe("7");
  });
});

describe("periods", () => {
  const now = new Date("2026-10-21T15:30:00Z"); // a Wednesday
  it("starts each period in UTC", () => {
    expect(periodStart("day", now).toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(periodStart("week", now).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(periodStart("month", now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodStart("total", now).getTime()).toBe(0);
  });
  it("puts Sunday in the week that began the Monday before", () => {
    expect(periodStart("week", new Date("2026-10-25T23:00:00Z")).toISOString()).toBe(
      "2026-10-19T00:00:00.000Z",
    );
  });
});

describe("budgets", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const limits = [{ asset: "USD", amount: "10000", period: "month" as const }];
  const card = (over: Partial<BudgetCard>): BudgetCard => ({
    asset: "USD",
    limit: 2000n,
    spent: 0n,
    open: true,
    createdAt: new Date("2026-10-05T00:00:00Z"),
    ...over,
  });

  it("counts open cards for their limit and closed ones for what they spent", () => {
    const cards = [
      card({}),
      card({ open: false, spent: 500n }),
      // Last month's, and another asset's, don't count.
      card({ createdAt: new Date("2026-09-30T23:59:59Z") }),
      card({ asset: "BTC", limit: 999999n }),
    ];
    const left = allowance(limits, cards, "USD", now);
    expect(left?.used).toBe(2500n);
    expect(left?.remaining).toBe(7500n);
  });

  it("allows a card that fits and refuses one that doesn't", () => {
    const cards = [card({ limit: 6000n })];
    expect(checkCard(limits, cards, "USD", 4000n, now)).toEqual({ ok: true });
    const over = checkCard(limits, cards, "USD", 4001n, now, (m) => formatAmount(m, 2));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("40.00 USD is left this month, of 100.00");
  });

  it("refuses without a limit, and refuses nothing at all", () => {
    expect(checkCard([], [], "USD", 1n, now).ok).toBe(false);
    expect(checkCard(limits, [], "USD", 0n, now).ok).toBe(false);
  });

  it("never goes below zero", () => {
    const cards = [card({ open: false, spent: 20000n })];
    expect(allowance(limits, cards, "USD", now)?.remaining).toBe(0n);
  });
});

describe("wallet keys", () => {
  const treasury = new Uint8Array(32).fill(7);
  it("are the same every time, and differ by card and chain", () => {
    const a = deriveWalletKey(treasury, "bitcoin", "card_1");
    expect(deriveWalletKey(treasury, "bitcoin", "card_1")).toEqual(a);
    expect(deriveWalletKey(treasury, "bitcoin", "card_2")).not.toEqual(a);
    expect(deriveWalletKey(treasury, "ethereum", "card_1")).not.toEqual(a);
    expect(a).toHaveLength(32);
  });
  it("want a real secret", () => {
    expect(() => deriveWalletKey(new Uint8Array(8), "bitcoin", "card_1")).toThrow();
  });
});

describe("loading plugins", () => {
  const configured = defineBankFactory({
    id: "fake",
    env: ["FAKE_KEY"],
    fromEnv: (env) => (env.FAKE_KEY ? fakePlugin("fake") : null),
  });
  const broken = defineBankFactory({
    id: "broken",
    env: ["BROKEN_KEY"],
    fromEnv: (env) => (env.BROKEN_KEY ? fakePlugin(requireEnv(env, "BROKEN_OTHER")) : null),
  });

  it("loads what's set up, skips what isn't, and reports what's wrong", () => {
    const { plugins, errors } = loadBankPlugins(
      [configured, broken],
      { FAKE_KEY: "x", BROKEN_KEY: "y" },
      deps,
    );
    expect([...plugins.keys()]).toEqual(["fake"]);
    expect(errors.get("broken")).toBe("BROKEN_OTHER isn't set");
    expect(loadBankPlugins([configured], {}, deps).plugins.size).toBe(0);
  });

  it("refuses two plugins with one id", () => {
    expect(() => loadBankPlugins([configured, configured], {}, deps)).toThrow(/Two bank plugins/);
  });
});
