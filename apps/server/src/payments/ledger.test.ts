import { describe, expect, it } from "vitest";
import { committed, periodStart, remaining, totalSpent, type LedgerCard } from "./ledger.ts";

const may = (day: number) => new Date(Date.UTC(2026, 4, day));
const april = new Date(Date.UTC(2026, 3, 20));

describe("the spending ledger", () => {
  it("counts a monthly limit from the start of the month in UTC", () => {
    expect(periodStart("monthly", new Date("2026-05-31T23:30:00-05:00"))).toEqual(
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(periodStart("all_time", may(3))).toBeNull();
  });

  it("holds a live card's whole limit, however little it has spent", () => {
    const live: LedgerCard = {
      status: "active",
      limitCents: 5000,
      charges: [{ amountCents: 1200, at: may(2) }],
    };
    expect(committed([live], may(1))).toBe(5000);
    expect(remaining(8000, [live], may(1))).toBe(3000);
  });

  it("counts what closed cards spent in the period, and nothing before it", () => {
    const closed: LedgerCard = {
      status: "used",
      limitCents: 5000,
      charges: [
        { amountCents: 2000, at: april },
        { amountCents: 1500, at: may(4) },
      ],
    };
    expect(committed([closed], may(1))).toBe(1500);
    expect(committed([closed], null)).toBe(3500);
  });

  it("nets refunds off, but never below nothing", () => {
    const refunded: LedgerCard = {
      status: "cancelled",
      limitCents: 1000,
      charges: [
        { amountCents: 1000, at: may(2) },
        { amountCents: -1000, at: may(3) },
        { amountCents: -500, at: may(4) },
      ],
    };
    expect(committed([refunded], may(1))).toBe(0);
    expect(totalSpent(refunded)).toBe(0);
  });

  it("holds what a live card spent past its own limit", () => {
    const over: LedgerCard = {
      status: "active",
      limitCents: 1000,
      charges: [{ amountCents: 1300, at: may(2) }],
    };
    expect(committed([over], may(1))).toBe(1300);
    expect(remaining(1000, [over], may(1))).toBe(0);
  });
});
