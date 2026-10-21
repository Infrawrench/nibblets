import { formatAmount, MASKED, parseAmount, type CardSecret } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import {
  allowance,
  changedLockedFields,
  checkCard,
  defineBankFactory,
  defineBankPlugin,
  defineField,
  deriveWalletKey,
  loadBankPlugins,
  maskSettings,
  mergeSettings,
  periodStart,
  requireSetting,
  newBankId,
  resolveBanks,
  oneAtATime,
  walletSpent,
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
    instrument: "card",
    fundAt: null,
    check: async () => {},
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
      // Last month's closed card, and another asset's, don't count.
      card({ open: false, spent: 900n, createdAt: new Date("2026-09-30T23:59:59Z") }),
      card({ asset: "BTC", limit: 999999n }),
    ];
    const left = allowance(limits, cards, "USD", now);
    expect(left?.used).toBe(2500n);
    expect(left?.remaining).toBe(7500n);
  });

  it("counts a card left open from an earlier period, so they can't pile up", () => {
    const daily = [{ asset: "USD", amount: "10000", period: "day" as const }];
    const yesterday = new Date("2026-10-20T09:00:00Z");
    const cards = [card({ limit: 10000n, createdAt: yesterday })];
    expect(allowance(daily, cards, "USD", now)?.remaining).toBe(0n);
    expect(checkCard(daily, cards, "USD", 1n, now).ok).toBe(false);
    // Once it's killed, yesterday's spending stays in yesterday.
    const killed = [card({ limit: 10000n, open: false, spent: 3000n, createdAt: yesterday })];
    expect(allowance(daily, killed, "USD", now)?.remaining).toBe(10000n);
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

describe("loading banks", () => {
  const key = defineField("FAKE_KEY", "Key", { required: true, secret: true });
  const other = defineField("BROKEN_OTHER", "Other thing", { required: true });
  const configured = defineBankFactory({
    id: "fake",
    name: "Fake",
    about: "",
    instrument: "card",
    fields: [key],
    fromSettings: (settings) => (settings.FAKE_KEY ? fakePlugin("fake") : null),
  });
  const broken = defineBankFactory({
    id: "broken",
    name: "Broken",
    about: "",
    instrument: "card",
    fields: [defineField("BROKEN_KEY", "Key"), other],
    fromSettings: (settings) =>
      settings.BROKEN_KEY ? fakePlugin(requireSetting(settings, other)) : null,
  });
  const bank = (id: string, kind: string, settings: Record<string, string>, name = "") => ({
    id,
    kind,
    name,
    settings,
  });

  it("loads what's set up, skips what isn't, and reports what's wrong", () => {
    const { plugins, errors } = loadBankPlugins(
      [configured, broken],
      [
        bank("fake", "fake", { FAKE_KEY: "x" }),
        bank("broken", "broken", { BROKEN_KEY: "y" }),
        bank("half", "fake", {}),
        bank("gone", "lithic", { KEY: "z" }),
      ],
      deps,
    );
    expect([...plugins.keys()]).toEqual(["fake"]);
    expect(errors.get("broken")).toBe("Other thing is needed");
    expect(errors.get("gone")).toBe("there's no bank plugin called lithic");
  });

  it("loads several banks on one plugin, each under its own id and name", () => {
    const { plugins } = loadBankPlugins(
      [configured],
      [
        bank("fake", "fake", { FAKE_KEY: "x" }),
        bank("fake-travel", "fake", { FAKE_KEY: "y" }, "Travel"),
      ],
      deps,
    );
    expect([...plugins.values()].map((p) => [p.id, p.label])).toEqual([
      ["fake", "fake"],
      ["fake-travel", "Travel · fake"],
    ]);
  });

  it("refuses two plugins, or two banks, with one id", () => {
    expect(() => loadBankPlugins([configured, configured], [], deps)).toThrow(/Two bank plugins/);
    const twice = bank("fake", "fake", { FAKE_KEY: "x" });
    expect(() => loadBankPlugins([configured], [twice, twice], deps)).toThrow(/Two banks/);
  });

  it("take a bank from the environment under the plugin's id, unless one's saved there", () => {
    const env = { FAKE_KEY: "from-env", PATH: "/bin" };
    expect(resolveBanks([configured], [], env)).toEqual([
      { id: "fake", kind: "fake", name: "", settings: { FAKE_KEY: "from-env" }, source: "env" },
    ]);
    const saved = [bank("fake", "fake", { FAKE_KEY: "saved" })];
    expect(resolveBanks([configured], saved, env)).toEqual([{ ...saved[0], source: "saved" }]);
    // A second saved bank leaves the plugin's id, and so the environment's, alone.
    const other = [bank("fake-travel", "fake", { FAKE_KEY: "saved" }, "Travel")];
    expect(resolveBanks([configured], other, env).map((b) => [b.id, b.source])).toEqual([
      ["fake-travel", "saved"],
      ["fake", "env"],
    ]);
    expect(resolveBanks([configured], [], { FAKE_KEY: "  " })).toEqual([]);
  });

  it("give the first bank on a plugin its id, and later ones their names", () => {
    expect(newBankId("slash", "Travel", new Set())).toBe("slash");
    expect(newBankId("slash", "Travel & Ops!", new Set(["slash"]))).toBe("slash-travel-ops");
    expect(newBankId("slash", "Travel", new Set(["slash", "slash-travel"]))).toBe("slash-travel-2");
    expect(newBankId("slash", "", new Set(["slash"]))).toBe("slash-2");
    expect(newBankId("slash", "x".repeat(80), new Set(["slash"]))).toMatch(/^slash-x{29}$/);
  });
});

describe("settings from a form", () => {
  const fields = [
    defineField("KEY", "Key", { secret: true, lockedByCards: true }),
    defineField("URL", "URL"),
    defineField("NOTE", "Note"),
  ];

  it("keep a secret sent masked, drop blanks and strangers, and trim", () => {
    expect(
      mergeSettings(
        fields,
        { KEY: MASKED, URL: " https://x ", NOTE: "", EXTRA: "y" },
        {
          KEY: "secret",
          NOTE: "old",
        },
      ),
    ).toEqual({ KEY: "secret", URL: "https://x" });
    expect(mergeSettings(fields, { KEY: "new" }, { KEY: "secret" })).toEqual({ KEY: "new" });
  });

  it("show secrets masked", () => {
    expect(maskSettings(fields, { KEY: "secret", URL: "https://x" })).toEqual({
      KEY: MASKED,
      URL: "https://x",
    });
  });

  it("say which locked fields would change", () => {
    expect(changedLockedFields(fields, { KEY: "a", URL: "x" }, { KEY: "a", URL: "y" })).toEqual([]);
    expect(changedLockedFields(fields, { KEY: "a" }, { KEY: "b" }).map((f) => f.key)).toEqual([
      "KEY",
    ]);
  });
});

describe("wallets", () => {
  it("count nothing spent until the wallet has sent something", () => {
    expect(walletSpent(1000n, 0n, false)).toBe(0n);
    expect(walletSpent(1000n, 400n, true)).toBe(600n);
    expect(walletSpent(1000n, 1500n, true)).toBe(0n);
  });

  it("run treasury work one piece at a time, even after a failure", async () => {
    const queue = oneAtATime();
    const order: string[] = [];
    const slow = (name: string, ms: number, fail = false) =>
      queue(async () => {
        order.push(`${name} start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name} end`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([slow("a", 20, true), slow("b", 1), slow("c", 1)]);
    expect(order).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
});
