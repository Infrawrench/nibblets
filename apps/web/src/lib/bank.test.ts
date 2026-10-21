import { describe, expect, it } from "vitest";
import { bankAssets, draftOf, limitsOf, money } from "./bank.ts";

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
