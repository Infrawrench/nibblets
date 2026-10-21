import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MonthlyBudget, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "../ui/Field.tsx";

const usd = (n: number) => `$${n.toFixed(2)}`;

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, { month: "long", timeZone: "UTC" });

/**
 * The most a nibblet may spend on API keys in a month, and what it has spent
 * so far. A sub-agent spends its parent's, so it has nothing to set.
 */
export function BudgetSection({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const qc = useQueryClient();
  const saved = nibblet.monthlyBudgetUsd;
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(saved === null ? "" : String(saved)), [saved]);

  const spend = useQuery({
    queryKey: keys.spend(connection.id, nibblet.id),
    queryFn: () => connection.client.nibblets.spend({ id: nibblet.id }),
    refetchInterval: 15_000,
    enabled: !nibblet.parentId,
  });

  if (nibblet.parentId) return null;

  const trimmed = draft.trim().replace(/^\$/, "");
  const parsed = trimmed === "" ? null : MonthlyBudget.safeParse(Number(trimmed));
  const invalid = parsed !== null && !parsed.success;
  const next = parsed?.success ? parsed.data : null;
  const changed = !invalid && next !== saved;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await connection.client.nibblets.update({ id: nibblet.id, monthlyBudgetUsd: next });
      void qc.invalidateQueries({ queryKey: keys.spend(connection.id, nibblet.id) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const status = spend.data;
  const share = status?.budgetUsd ? Math.min(1, status.spentUsd / status.budgetUsd) : null;

  return (
    <>
      <SectionHeading>Budget</SectionHeading>
      <FieldRow
        label="Monthly limit"
        hint="For Claude, ChatGPT and DeepSeek on API keys, including its sub-agents. Subscriptions don't count. Empty for no limit."
      >
        <div className="flex gap-1.5">
          <div className="relative w-36">
            <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-sm text-faint">
              $
            </span>
            <Input
              className="pl-5"
              inputMode="decimal"
              placeholder="No limit"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && changed) void save();
              }}
            />
          </div>
          <Button disabled={!changed || saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
        {invalid ? <span className="text-xs text-danger">Enter an amount in dollars.</span> : null}
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </FieldRow>
      {status ? (
        <FieldRow label="Spent">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-dim">
              {usd(status.spentUsd)}
              {status.budgetUsd !== null ? ` of ${usd(status.budgetUsd)}` : ""} in{" "}
              {monthName(status.month)}
              {!status.allowed ? " · spent, so it's waiting for next month" : ""}
            </span>
            {share !== null ? (
              <div className="h-1.5 w-48 overflow-hidden rounded-full bg-hover">
                <div
                  className={cn("h-full rounded-full", status.allowed ? "bg-ok" : "bg-danger")}
                  style={{ width: `${share * 100}%` }}
                />
              </div>
            ) : null}
          </div>
        </FieldRow>
      ) : null}
    </>
  );
}
