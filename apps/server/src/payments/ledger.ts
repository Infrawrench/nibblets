import type { CardStatus, SpendPeriod } from "@nibblet/protocol";

/**
 * What a nibblet has out against its spending limit. A live card counts in
 * full, whatever it's spent so far, because it could still spend all of it;
 * a closed card counts what it actually spent in the period.
 */

export interface LedgerCard {
  status: CardStatus;
  limitCents: number;
  charges: readonly { amountCents: number; at: Date }[];
}

/** The start of the period a limit is counted over: this calendar month in UTC, or never. */
export function periodStart(period: SpendPeriod, now: Date): Date | null {
  if (period === "all_time") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function spentSince(card: LedgerCard, since: Date | null): number {
  return card.charges
    .filter((c) => since === null || c.at >= since)
    .reduce((sum, c) => sum + c.amountCents, 0);
}

export function committed(cards: readonly LedgerCard[], since: Date | null): number {
  let total = 0;
  for (const card of cards) {
    const spent = Math.max(0, spentSince(card, since));
    // A live card may have gone over if its own limit is looser than ours.
    total += card.status === "active" ? Math.max(card.limitCents, spent) : spent;
  }
  return total;
}

export function remaining(limitCents: number, cards: readonly LedgerCard[], since: Date | null) {
  return Math.max(0, limitCents - committed(cards, since));
}

/** Total spent on a card, ever: refunds net off, never below nothing. */
export function totalSpent(card: Pick<LedgerCard, "charges">): number {
  return Math.max(
    0,
    card.charges.reduce((sum, c) => sum + c.amountCents, 0),
  );
}
