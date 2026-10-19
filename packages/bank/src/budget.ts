import type { SpendingLimit, SpendingPeriod } from "@nibblet/protocol";

/** A card as far as a budget cares. */
export interface BudgetCard {
  asset: string;
  limit: bigint;
  spent: bigint;
  open: boolean;
  createdAt: Date;
}

/** When the period `now` falls in began, in UTC. Weeks start on Monday. */
export function periodStart(period: SpendingPeriod, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case "day":
      return new Date(Date.UTC(y, m, d));
    case "week":
      return new Date(Date.UTC(y, m, d - ((now.getUTCDay() + 6) % 7)));
    case "month":
      return new Date(Date.UTC(y, m, 1));
    case "total":
      return new Date(0);
  }
}

/**
 * What a card takes out of its budget: its whole limit while it's open,
 * since it could still all be spent, and what was spent once it's closed.
 */
export function cardCost(card: BudgetCard): bigint {
  if (!card.open) return card.spent;
  return card.spent > card.limit ? card.spent : card.limit;
}

export interface Allowance {
  limit: SpendingLimit;
  /** Taken by cards still open, whenever they were made, and by ones closed that were made this period. */
  used: bigint;
  /** Never below zero. */
  remaining: bigint;
  /** When the period began. */
  since: Date;
}

/** Where a nibblet stands against its limit in one asset, or null when it has none. */
export function allowance(
  limits: readonly SpendingLimit[],
  cards: readonly BudgetCard[],
  asset: string,
  now: Date,
): Allowance | null {
  const limit = limits.find((l) => l.asset === asset);
  if (!limit) return null;
  const since = periodStart(limit.period, now);
  let used = 0n;
  for (const card of cards) {
    // An open card could still all be spent now, so it counts whenever it was made.
    if (card.asset === asset && (card.open || card.createdAt >= since)) used += cardCost(card);
  }
  const cap = BigInt(limit.amount);
  return { limit, used, remaining: used >= cap ? 0n : cap - used, since };
}

export type CardCheck = { ok: true } | { ok: false; reason: string };

/** Whether a new card for `amount` fits in the nibblet's limit. */
export function checkCard(
  limits: readonly SpendingLimit[],
  cards: readonly BudgetCard[],
  asset: string,
  amount: bigint,
  now: Date,
  format: (minor: bigint) => string = String,
): CardCheck {
  if (amount <= 0n) return { ok: false, reason: "A card needs a limit above zero." };
  const left = allowance(limits, cards, asset, now);
  if (!left) {
    return {
      ok: false,
      reason: `You have no spending limit in ${asset}, so you can't have a card in it. Ask your person to set one.`,
    };
  }
  if (amount > left.remaining) {
    const per = left.limit.period === "total" ? "in total" : `this ${left.limit.period}`;
    return {
      ok: false,
      reason: `That's over your limit: ${format(left.remaining)} ${asset} is left ${per}, of ${format(BigInt(left.limit.amount))}. Kill cards you've finished with to free up what they didn't spend.`,
    };
  }
  return { ok: true };
}
