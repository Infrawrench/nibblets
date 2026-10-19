import {
  formatAmount,
  MASKED,
  parseAmount,
  SpendingPeriod,
  type AssetInfo,
  type BankField,
  type BankKind,
  type BankSettings,
  type BankSetup,
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

/**
 * A bank's settings form as typed, by field key. A secret is empty unless a
 * new one is typed, which keeps the one that's saved.
 */
export type BankDraft = Record<string, string>;

/** Whether a field already has a secret saved, which the form never sees. */
export function secretSaved(settings: BankSettings, field: BankField): boolean {
  return field.secret && settings[field.key] === MASKED;
}

/** The form for a bank on this plugin with these settings ({} for a new one). */
export function bankDraftOf(kind: BankKind, settings: BankSettings): BankDraft {
  return Object.fromEntries(
    kind.fields.map((f) => [f.key, secretSaved(settings, f) ? "" : (settings[f.key] ?? "")]),
  );
}

/** What to send the server: a secret left empty, but saved, is sent as `MASKED` to keep it. */
export function bankSettingsOf(
  kind: BankKind,
  settings: BankSettings,
  draft: BankDraft,
): BankSettings {
  return Object.fromEntries(
    kind.fields.map((f) => {
      const value = draft[f.key]?.trim() ?? "";
      return [f.key, value === "" && secretSaved(settings, f) ? MASKED : value];
    }),
  );
}

/** The first required field that's neither typed nor saved. */
export function missingField(
  kind: BankKind,
  settings: BankSettings,
  draft: BankDraft,
): BankField | null {
  return (
    kind.fields.find((f) => f.required && !draft[f.key]?.trim() && !secretSaved(settings, f)) ??
    null
  );
}

/** Whether the form says anything different from these settings. */
export function bankDraftChanged(
  kind: BankKind,
  settings: BankSettings,
  draft: BankDraft,
): boolean {
  const saved = bankDraftOf(kind, settings);
  return kind.fields.some((f) => (draft[f.key]?.trim() ?? "") !== saved[f.key]);
}

/**
 * Whether a bank on this plugin needs a name: one can go without, and the
 * rest need one to tell them apart.
 */
export function needsName(banks: readonly BankSetup[], kind: string, id: string | null): boolean {
  return banks.some((b) => b.kind === kind && b.id !== id && !b.name);
}

/** "Travel (Slash)", or just "Slash". */
export function bankTitle(name: string, kindName: string): string {
  return name ? `${name} (${kindName})` : kindName;
}

/** A fresh private key: 32 random bytes as hex, which every chain's plugin takes. */
export function newPrivateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
