import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, Wallet } from "lucide-react";
import { SpendingPeriod, type Card, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import {
  bankAssets,
  describeCard,
  draftOf,
  limitsOf,
  money,
  periodLabels,
  type LimitsDraft,
} from "../../lib/bank.ts";
import { keys } from "../../lib/servers.tsx";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading, Select } from "../ui/Field.tsx";

const periodOptions = SpendingPeriod.options.map((p) => ({ value: p, label: periodLabels[p] }));

/**
 * What a nibblet may spend, in each asset the server's banks deal in, and
 * the cards it has. Only the person sets the limits; the nibblet asks for
 * cards within them. Hidden when no bank is set up.
 */
export function NibbletSpending({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const status = useQuery({
    queryKey: keys.bank(connection.id),
    queryFn: () => connection.client.bank.status({}),
  });
  const cards = useQuery({
    queryKey: keys.cards(connection.id, nibblet.id),
    queryFn: () => connection.client.bank.cards({ nibbletId: nibblet.id }),
  });
  const allowances = useQuery({
    queryKey: keys.allowances(connection.id, nibblet.id),
    queryFn: () => connection.client.bank.allowances({ nibbletId: nibblet.id }),
  });
  const assets = useMemo(() => bankAssets(status.data?.providers ?? []), [status.data]);
  const saved = useMemo(
    () => draftOf(nibblet.spendingLimits, assets),
    [nibblet.spendingLimits, assets],
  );
  const [draft, setDraft] = useState<LimitsDraft>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(saved), [saved]);

  if (assets.length === 0 && !cards.data?.length) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    const result = limitsOf(draft, assets, nibblet.spendingLimits);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connection.client.nibblets.update({ id: nibblet.id, spendingLimits: result.limits });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeading>Spending</SectionHeading>
      <p className="text-xs text-faint">
        The most it may put on cards. Open cards count in full until they're killed. Leave a limit
        empty for no cards in that currency.
      </p>
      {assets.map((asset) => {
        const entry = draft[asset.code] ?? { amount: "", period: "month" };
        const left = allowances.data?.find((a) => a.limit.asset === asset.code);
        return (
          <FieldRow
            key={asset.code}
            label={asset.code}
            hint={left ? `${money(left.remaining, asset)} left` : undefined}
          >
            <span className="flex gap-1.5">
              <Input
                className="w-32"
                inputMode="decimal"
                placeholder="No cards"
                value={entry.amount}
                onChange={(e) =>
                  setDraft({ ...draft, [asset.code]: { ...entry, amount: e.target.value } })
                }
              />
              <Select
                className="w-32"
                value={entry.period}
                options={periodOptions}
                onChange={(v) => {
                  const period = SpendingPeriod.safeParse(v);
                  if (period.success)
                    setDraft({ ...draft, [asset.code]: { ...entry, period: period.data } });
                }}
              />
            </span>
          </FieldRow>
        );
      })}
      {dirty || error ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
            Save limits
          </Button>
          {dirty ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>
              Cancel
            </Button>
          ) : null}
          {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
      ) : null}
      <CardList connection={connection} cards={cards.data ?? []} />
    </>
  );
}

function CardList({ connection, cards }: { connection: ServerConnection; cards: Card[] }) {
  const [showClosed, setShowClosed] = useState(false);
  const open = cards.filter((c) => c.state !== "closed");
  const closed = cards.filter((c) => c.state === "closed");
  if (cards.length === 0) return <p className="text-xs text-faint">No cards yet.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {open.map((card) => (
        <CardRow key={card.id} connection={connection} card={card} />
      ))}
      {open.length === 0 ? <p className="text-xs text-faint">No open cards.</p> : null}
      {closed.length > 0 ? (
        <button
          type="button"
          className="self-start text-xs text-dim hover:text-text"
          onClick={() => setShowClosed(!showClosed)}
        >
          {showClosed ? "Hide" : "Show"} {closed.length} closed
        </button>
      ) : null}
      {showClosed
        ? closed.map((card) => <CardRow key={card.id} connection={connection} card={card} />)
        : null}
    </div>
  );
}

const closedByLabel: Record<NonNullable<Card["closedBy"]>, string> = {
  nibblet: "killed by the nibblet",
  user: "killed by you",
  provider: "closed after use",
  server: "closed: it couldn't reach the container",
};

/** What a card that isn't closed is doing, and since when. */
function liveLabel(card: Card): string {
  const made = relativeTime(card.createdAt);
  if (card.state === "pending") return `being made (asked ${made})`;
  if (card.state === "closing") return `closing, waiting on ${card.provider} · made ${made}`;
  return `made ${made}`;
}

function CardRow({ connection, card }: { connection: ServerConnection; card: Card }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kill = async () => {
    setBusy(true);
    setError(null);
    try {
      await connection.client.bank.kill({ id: card.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const Icon = card.display.startsWith("•") ? CreditCard : Wallet;
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2">
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${card.state === "closed" ? "text-faint" : "text-accent"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium" title={card.purpose}>
          {card.purpose}
        </span>
        <span className="font-mono text-2xs break-all text-dim">{card.display}</span>
        <span className="text-xs text-dim">
          {describeCard(card)} · {card.provider} ·{" "}
          {card.state === "closed"
            ? `${card.closedBy ? closedByLabel[card.closedBy] : "closed"} ${card.closedAt ? relativeTime(card.closedAt) : ""}`
            : liveLabel(card)}
        </span>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
      {card.state === "open" || card.state === "closing" ? (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void kill()}>
          Kill
        </Button>
      ) : null}
    </div>
  );
}
