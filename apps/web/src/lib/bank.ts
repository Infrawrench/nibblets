import {
  formatAmount,
  parseAmount,
  SpendingPeriod,
  type AssetInfo,
  type Card,
  type SpendingLimit,
} from "@nibblet/protocol";

/** One asset's limit as typed: an amount in its own units (empty for none), and a period. */
export interface LimitDraft {
  amount: string;
  period: SpendingPeriod;
}

export type LimitsDraft = Record<string, LimitDraft>;

export const periodLabels: Record<SpendingPeriod, string> = {
  day: "a day",
  week: "a week",
  month: "a month",
  total: "in total",
};

/** The assets the server's banks deal in, once each. */
export function bankAssets(providers: readonly { asset: AssetInfo }[]): AssetInfo[] {
  const seen = new Map<string, AssetInfo>();
  for (const p of providers) if (!seen.has(p.asset.code)) seen.set(p.asset.code, p.asset);
  return [...seen.values()];
}

export function draftOf(
  limits: readonly SpendingLimit[],
  assets: readonly AssetInfo[],
): LimitsDraft {
  return Object.fromEntries(
    assets.map((asset) => {
      const limit = limits.find((l) => l.asset === asset.code);
      return [
        asset.code,
        {
          amount: limit ? formatAmount(limit.amount, asset.decimals) : "",
          period: limit?.period ?? "month",
        },
      ];
    }),
  );
}

/**
 * The limits a draft sets, or what's wrong with it. Limits in assets no bank
 * here deals in are kept as they were, since they can't be shown to change.
 */
export function limitsOf(
  draft: LimitsDraft,
  assets: readonly AssetInfo[],
  previous: readonly SpendingLimit[],
): { limits: SpendingLimit[] } | { error: string } {
  const shown = new Set(assets.map((a) => a.code));
  const limits = previous.filter((l) => !shown.has(l.asset));
  for (const asset of assets) {
    const entry = draft[asset.code];
    const text = entry?.amount.trim() ?? "";
    if (!entry || text === "") continue;
    let amount: bigint;
    try {
      amount = parseAmount(text, asset.decimals);
    } catch (err) {
      return { error: `${asset.code}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (amount === 0n) continue;
    limits.push({ asset: asset.code, amount: amount.toString(), period: entry.period });
  }
  return { limits };
}

/** `12.50 USD`. */
export function money(minor: string | bigint, asset: AssetInfo): string {
  return `${formatAmount(minor, asset.decimals)} ${asset.code}`;
}

/** A card's line in a list: what it is and what's gone on it. */
export function describeCard(card: Card): string {
  const kind = card.kind === "single_use" ? "Single use" : "Multi use";
  return `${kind} · ${money(card.spent, card.asset)} of ${money(card.limit, card.asset)}`;
}
