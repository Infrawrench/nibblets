import { describe, expect, it } from "vitest";
import { MASKED, type BankField, type BankKind, type BankSetup } from "@nibblets/protocol";
import {
  bankAssets,
  bankDraftChanged,
  bankDraftOf,
  bankSettingsOf,
  bankTitle,
  draftOf,
  limitsOf,
  missingField,
  money,
  needsName,
  newPrivateKey,
} from "./bank.ts";

const usd = { code: "USD", decimals: 2 };
const btc = { code: "BTC", decimals: 8 };

describe("bank limits", () => {
  it("lists each asset once", () => {
    expect(bankAssets([{ asset: usd }, { asset: btc }, { asset: usd }])).toEqual([usd, btc]);
  });

  it("shows limits in each asset's own units", () => {
    expect(draftOf([{ asset: "BTC", amount: "100000", period: "total" }], [usd, btc])).toEqual({
      USD: { amount: "", period: "month" },
      BTC: { amount: "0.001", period: "total" },
    });
  });

  it("turns a draft back into limits, dropping empty ones", () => {
    const draft = {
      USD: { amount: "50", period: "week" as const },
      BTC: { amount: "", period: "month" as const },
    };
    expect(limitsOf(draft, [usd, btc], [])).toEqual({
      limits: [{ asset: "USD", amount: "5000", period: "week" }],
    });
    expect(limitsOf({ USD: { amount: "0", period: "day" } }, [usd], [])).toEqual({ limits: [] });
  });

  it("keeps limits in assets no bank here deals in", () => {
    const eth = { asset: "ETH", amount: "1", period: "day" as const };
    expect(limitsOf({ USD: { amount: "1", period: "day" } }, [usd], [eth])).toEqual({
      limits: [eth, { asset: "USD", amount: "100", period: "day" }],
    });
  });

  it("says what's wrong with an amount", () => {
    expect(limitsOf({ USD: { amount: "1.234", period: "day" } }, [usd], [])).toEqual({
      error: 'USD: "1.234" has more than 2 decimal places',
    });
  });

  it("formats money", () => {
    expect(money("1250", usd)).toBe("12.50 USD");
    expect(money(100000n, btc)).toBe("0.001 BTC");
  });
});

const field = (key: string, more: Partial<BankField> = {}): BankField => ({
  key,
  label: key,
  hint: null,
  placeholder: null,
  required: false,
  secret: false,
  options: null,
  generate: null,
  lockedByCards: false,
  ...more,
});

const kind: BankKind = {
  id: "fake",
  name: "Fake",
  about: "",
  instrument: "wallet",
  purchaseHook: null,
  fields: [field("KEY", { secret: true, required: true }), field("NETWORK", { required: true })],
};

const setup = (id: string, name: string, kind = "fake"): BankSetup => ({
  id,
  kind,
  name,
  source: "saved",
  settings: {},
  liveCards: 0,
});

describe("bank settings forms", () => {
  it("start with what's saved, but never a secret", () => {
    expect(bankDraftOf(kind, { KEY: MASKED, NETWORK: "signet" })).toEqual({
      KEY: "",
      NETWORK: "signet",
    });
    expect(bankDraftOf(kind, {})).toEqual({ KEY: "", NETWORK: "" });
  });

  it("keep a saved secret that isn't retyped", () => {
    const saved = { KEY: MASKED, NETWORK: "signet" };
    expect(bankSettingsOf(kind, saved, { KEY: "", NETWORK: "mainnet" })).toEqual({
      KEY: MASKED,
      NETWORK: "mainnet",
    });
    expect(bankSettingsOf(kind, saved, { KEY: " new ", NETWORK: "signet" })).toEqual({
      KEY: "new",
      NETWORK: "signet",
    });
    // A new bank has nothing saved to keep.
    expect(bankSettingsOf(kind, {}, { KEY: "", NETWORK: "signet" })).toEqual({
      KEY: "",
      NETWORK: "signet",
    });
  });

  it("say what's still needed, counting saved secrets as there", () => {
    expect(missingField(kind, {}, { KEY: "k", NETWORK: "" })?.key).toBe("NETWORK");
    expect(missingField(kind, { KEY: MASKED }, { KEY: "", NETWORK: "signet" })).toBeNull();
  });

  it("know when something's changed", () => {
    const saved = { KEY: MASKED, NETWORK: "signet" };
    expect(bankDraftChanged(kind, saved, { KEY: "", NETWORK: "signet" })).toBe(false);
    expect(bankDraftChanged(kind, saved, { KEY: "x", NETWORK: "signet" })).toBe(true);
  });

  it("want a name once a bank on the plugin goes without one", () => {
    expect(needsName([], "fake", null)).toBe(false);
    expect(needsName([setup("fake", "")], "fake", null)).toBe(true);
    expect(needsName([setup("fake", "")], "fake", "fake")).toBe(false);
    expect(needsName([setup("fake", "Ops")], "fake", null)).toBe(false);
    expect(needsName([setup("other", "", "other")], "fake", null)).toBe(false);
    expect(bankTitle("Travel", "Slash")).toBe("Travel (Slash)");
    expect(bankTitle("", "Slash")).toBe("Slash");
  });

  it("make 32-byte keys, a new one each time", () => {
    const key = newPrivateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(newPrivateKey()).not.toBe(key);
  });
});
