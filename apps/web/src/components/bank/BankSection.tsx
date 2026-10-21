import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, Plus, XCircle } from "lucide-react";
import type { BankProvider, BankSetup } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { bankTitle, money } from "../../lib/bank.ts";
import { keys } from "../../lib/servers.tsx";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { BankDialog } from "./BankDialog.tsx";

/**
 * The banks nibblets' cards come from: card issuers and crypto treasuries,
 * set up here, and what each has left to fund cards with.
 */
export function BankSection({ connection }: { connection: ServerConnection }) {
  const status = useQuery({
    queryKey: keys.bank(connection.id),
    queryFn: () => connection.client.bank.status({}),
    refetchInterval: 60_000,
  });
  /** A bank's id to edit it, null to add one, undefined when the dialog's closed. */
  const [dialog, setDialog] = useState<string | null | undefined>(undefined);
  // Card events don't refetch this (it asks every provider for its balance),
  // so the open cards that lock a bank's fields are fetched fresh for the form.
  const open = (id: string | null) => {
    setDialog(id);
    void status.refetch();
  };
  const kinds = status.data?.kinds ?? [];
  // Each plugin's banks together, in the order the server lists its plugins.
  const banks = [...(status.data?.banks ?? [])].sort(
    (a, b) => kinds.findIndex((k) => k.id === a.kind) - kinds.findIndex((k) => k.id === b.kind),
  );
  return (
    <>
      <SectionHeading
        action={
          kinds.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => open(null)}>
              <Plus />
              Add a bank
            </Button>
          ) : null
        }
      >
        Bank
      </SectionHeading>
      <p className="text-xs text-faint">
        {banks.length === 0
          ? "No bank is set up, so nibblets can't have cards. Add a card issuer or a crypto treasury, then give each nibblet a spending limit in its settings."
          : "Nibblets get cards from these, within the spending limit you give each one in its settings."}
      </p>
      {banks.map((bank) => (
        <BankRow
          key={bank.id}
          bank={bank}
          kindName={kinds.find((k) => k.id === bank.kind)?.name ?? bank.kind}
          provider={status.data?.providers.find((p) => p.id === bank.id) ?? null}
          problem={status.data?.problems.find((p) => p.id === bank.id)?.detail ?? null}
          onEdit={() => open(bank.id)}
        />
      ))}
      <BankDialog
        connection={connection}
        kinds={kinds}
        banks={banks}
        chosen={dialog}
        onClose={() => setDialog(undefined)}
      />
    </>
  );
}

function BankRow({
  bank,
  kindName,
  provider,
  problem,
  onEdit,
}: {
  bank: BankSetup;
  /** Its plugin's name, "Slash". */
  kindName: string;
  provider: BankProvider | null;
  /** Why its settings don't load, if they don't. */
  problem: string | null;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const ready = provider?.state === "ready";
  const detail = !provider
    ? `Not set up: ${problem ?? "its settings aren't finished"}`
    : provider.state === "error"
      ? `Can't be reached: ${provider.detail ?? "no reason given"}`
      : provider.balance !== null
        ? `${money(provider.balance, provider.asset)} available`
        : "Ready";
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2">
      {ready ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {provider?.label ?? bankTitle(bank.name, kindName)}
          {provider ? (
            <span className="ml-1.5 font-normal text-dim">{provider.asset.code}</span>
          ) : null}
        </span>
        <span className="text-xs break-all text-dim">{detail}</span>
        {provider?.fundAt ? (
          <span className="flex items-center gap-1 text-xs text-faint">
            <span className="shrink-0">Top up at</span>
            <span className="min-w-0 truncate font-mono text-2xs text-dim" title={provider.fundAt}>
              {provider.fundAt}
            </span>
            <button
              type="button"
              title="Copy the address"
              className="shrink-0 rounded p-0.5 hover:bg-hover hover:text-text [&_svg]:size-3"
              onClick={() => {
                const address = provider.fundAt;
                if (!address) return;
                void navigator.clipboard.writeText(address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Copy />
            </button>
            {copied ? <span className="shrink-0">Copied</span> : null}
          </span>
        ) : null}
        {bank.source === "env" ? (
          <span className="text-2xs text-faint">From the server's environment</span>
        ) : null}
      </div>
      <Button size="sm" onClick={onEdit}>
        Edit
      </Button>
    </div>
  );
}
