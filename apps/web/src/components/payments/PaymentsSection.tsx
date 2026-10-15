import { useEffect, useState } from "react";
import { CheckCircle2, CreditCard, Pencil, Plus, Trash2, XCircle } from "lucide-react";
import {
  formatMoney,
  type IssuedCard,
  type Nibblet,
  type PaymentAccount,
  type PaymentPermission,
  type SpendPeriod,
} from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { cn } from "../../lib/cn.ts";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Input, SectionHeading } from "../ui/Field.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { AccountDialog } from "./AccountDialog.tsx";
import { moneyInput, parseMoney, useNibbletPayments, usePaymentAccounts } from "./usePayments.ts";

/** The "How this works" note, the one place the mechanics are spelt out. */
function HowItWorks() {
  return (
    <details className="text-2xs text-faint">
      <summary className="cursor-pointer select-none hover:text-dim">How this works</summary>
      <p className="mt-1">
        Each account keeps its own key on this server; nibblets never see it. In a nibblet's
        settings you give it a spending limit, monthly or all time, and let it use each account
        freely, only with your approval, or not at all. When it needs to pay, it asks for a card:
        one for a single purchase, which is closed shortly after it's charged, or one for a
        subscription, which gets whatever is left of its limit. Every open card holds its whole
        limit until it's closed. The card's details are written to a private file in the nibblet's
        container, outside its home folder, so they're never in a snapshot.
      </p>
    </details>
  );
}

/** Settings: the payment accounts on this server. */
export function PaymentsSettings({ connection }: { connection: ServerConnection }) {
  const { providers, accounts, remove, refresh } = usePaymentAccounts(connection);
  const [editing, setEditing] = useState<PaymentAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const list = providers.data ?? [];
  if (list.length === 0 && !accounts.data?.length) return null;
  return (
    <>
      <SectionHeading
        action={
          list.length ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus />
              Add account
            </Button>
          ) : null
        }
      >
        Payments
      </SectionHeading>
      <div className="flex flex-col gap-1.5">
        {accounts.data?.length === 0 ? (
          <p className="text-xs text-faint">
            Connect a bank account to let nibblets pay for things with cards, within limits you set
            for each one.
          </p>
        ) : null}
        {accounts.data?.map((a) => (
          <div
            key={a.id}
            className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
          >
            {a.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">
                {a.label}
                <span className="ml-1.5 font-normal text-dim">
                  {list.find((p) => p.id === a.provider)?.label ?? a.provider}
                </span>
              </span>
              {a.detail ? <span className="text-xs text-danger">{a.detail}</span> : null}
              {a.summary.map((line) => (
                <span key={line} className="text-xs text-dim">
                  {line}
                </span>
              ))}
            </div>
            <Button size="icon" variant="ghost" title="Change" onClick={() => setEditing(a)}>
              <Pencil />
            </Button>
            <Button
              size="sm"
              variant={confirmRemove === a.id ? "danger" : "ghost"}
              title="Remove, cancelling every open card from it"
              disabled={remove.isPending}
              onBlur={() => setConfirmRemove(null)}
              onClick={() => {
                if (confirmRemove !== a.id) return setConfirmRemove(a.id);
                remove.mutate(a.id);
                setConfirmRemove(null);
              }}
            >
              <Trash2 />
              {confirmRemove === a.id ? "Cancel its cards and remove?" : null}
            </Button>
          </div>
        ))}
        {remove.error ? <p className="text-xs text-danger">{remove.error.message}</p> : null}
        <HowItWorks />
      </div>
      <AccountDialog
        connection={connection}
        providers={list}
        account={editing}
        open={adding || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
        onSaved={() => void refresh()}
      />
    </>
  );
}

const permissionOptions: { value: PaymentPermission; label: string; title: string }[] = [
  { value: "allow", label: "Allow", title: "It gets cards without asking" },
  { value: "ask", label: "Ask", title: "You approve each card" },
  { value: "none", label: "None", title: "It can't use this account" },
];

/** One nibblet's spending limit, accounts and cards, in its settings panel. */
export function NibbletPayments({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const { accounts } = usePaymentAccounts(connection);
  const { overview, setPolicy, cancelCard } = useNibbletPayments(connection, nibblet.id);
  const o = overview.data;
  const [limit, setLimit] = useState("");
  useEffect(() => {
    if (o) setLimit(moneyInput(o.policy.limitCents));
  }, [o?.policy.limitCents, nibblet.id]);

  const cardAccounts = (accounts.data ?? []).filter((a) => a.kind === "card");
  if (!o || (cardAccounts.length === 0 && o.cards.length === 0)) return null;

  const parsed = parseMoney(limit);
  const limitDirty = parsed !== null && parsed !== o.policy.limitCents;
  const used = o.policy.limitCents ? Math.min(1, o.committedCents / o.policy.limitCents) : 0;
  const error = setPolicy.error ?? cancelCard.error;
  const live = o.cards.filter((c) => c.status === "active");
  const closed = o.cards.filter((c) => c.status !== "active");

  return (
    <>
      <SectionHeading>
        <span className="flex items-center gap-1.5">
          <CreditCard className="size-3.5" />
          Payments
        </span>
      </SectionHeading>
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 text-sm text-dim max-sm:w-full">Spending limit</span>
          <div className="relative w-28">
            <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint">
              $
            </span>
            <Input
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && limitDirty) setPolicy.mutate({ limitCents: parsed });
              }}
              className={cn("pl-5", parsed === null && "border-danger")}
              aria-label="Spending limit in dollars"
            />
          </div>
          <Segmented<SpendPeriod>
            value={o.policy.period}
            onChange={(period) => setPolicy.mutate({ period })}
            options={[
              {
                value: "monthly",
                label: "Monthly",
                title: "Starts afresh on the 1st of each month (UTC)",
              },
              { value: "all_time", label: "All time", title: "Never starts afresh" },
            ]}
          />
          {limitDirty ? (
            <Button
              size="sm"
              variant="primary"
              disabled={setPolicy.isPending}
              onClick={() => setPolicy.mutate({ limitCents: parsed })}
            >
              Save
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-deep">
            <div
              className={cn("h-full rounded-full", used >= 1 ? "bg-warning" : "bg-accent")}
              style={{ width: `${used * 100}%` }}
            />
          </div>
          <span className="text-faint">
            {formatMoney(o.committedCents)} held or spent
            {o.policy.period === "monthly" ? " this month" : ""} ·{" "}
            <span className="text-dim">{formatMoney(o.remainingCents)} left</span>
          </span>
        </div>

        {cardAccounts.length > 0 ? (
          <div className="flex flex-col">
            {cardAccounts.map((a) => (
              <div key={a.id} className="flex min-h-7 items-center gap-2">
                <span className="flex-1 truncate text-sm">{a.label}</span>
                <Segmented<PaymentPermission>
                  value={o.policy.access[a.id] ?? "none"}
                  onChange={(permission) => setPolicy.mutate({ access: { [a.id]: permission } })}
                  options={permissionOptions}
                />
              </div>
            ))}
          </div>
        ) : null}

        {live.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-line pt-2">
            {live.map((c) => (
              <CardRow
                key={c.id}
                card={c}
                busy={cancelCard.isPending}
                onCancel={() => cancelCard.mutate(c.id)}
              />
            ))}
          </div>
        ) : null}
        {closed.length > 0 ? (
          <details className="border-t border-line pt-1.5">
            <summary className="cursor-pointer text-faint select-none hover:text-dim">
              {closed.length} closed card{closed.length === 1 ? "" : "s"}
            </summary>
            <div className="mt-1 flex flex-col gap-1">
              {closed.map((c) => (
                <CardRow key={c.id} card={c} />
              ))}
            </div>
          </details>
        ) : null}

        {error ? <p className="text-danger">{error.message}</p> : null}
        <p className="text-faint">
          {nibblet.name} asks for a card when it's about to pay. Nothing is allowed until you set a
          limit and an account.
        </p>
      </div>
    </>
  );
}

const statusLabel: Record<IssuedCard["status"], string> = {
  active: "Open",
  used: "Used",
  cancelled: "Cancelled",
  expired: "Expired",
};

function CardRow({
  card,
  busy,
  onCancel,
}: {
  card: IssuedCard;
  busy?: boolean;
  onCancel?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <CreditCard
        className={cn("size-3.5 shrink-0", card.status === "active" ? "text-accent" : "text-faint")}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          <span className="font-mono">••{card.lastFour}</span>{" "}
          <span className="text-dim">{card.description}</span>
        </span>
        <span className="text-2xs text-faint">
          {card.purpose === "once" ? "One purchase" : "Recurring"}
          {card.source === "pool" ? " · agent card" : ""} · {formatMoney(card.spentCents)} of{" "}
          {formatMoney(card.limitCents)} · {statusLabel[card.status]}{" "}
          {relativeTime(card.closedAt ?? card.createdAt)}
          {card.closedReason ? ` · ${card.closedReason}` : ""}
        </span>
      </div>
      {onCancel ? (
        <Button
          size="sm"
          variant={confirm ? "danger" : "ghost"}
          disabled={busy}
          onBlur={() => setConfirm(false)}
          onClick={() => {
            if (!confirm) return setConfirm(true);
            setConfirm(false);
            onCancel();
          }}
        >
          {confirm ? "Really cancel?" : "Cancel"}
        </Button>
      ) : null}
    </div>
  );
}
