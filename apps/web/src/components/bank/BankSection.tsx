import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import type { ServerConnection } from "../../lib/connection.ts";
import { money } from "../../lib/bank.ts";
import { keys } from "../../lib/servers.tsx";
import { SectionHeading } from "../ui/Field.tsx";

/**
 * The banks nibblets' cards come from: card issuers and crypto treasuries,
 * set up in the server's settings, and what each has left to fund cards with.
 */
export function BankSection({ connection }: { connection: ServerConnection }) {
  const status = useQuery({
    queryKey: keys.bank(connection.id),
    queryFn: () => connection.client.bank.status({}),
    refetchInterval: 60_000,
  });
  const providers = status.data?.providers ?? [];
  const problems = status.data?.problems ?? [];
  return (
    <>
      <SectionHeading>Bank</SectionHeading>
      <p className="text-xs text-faint">
        {providers.length === 0 && problems.length === 0
          ? "No bank is set up, so nibblets can't have cards. Add your Slash account (SLASH_API_KEY) or a crypto treasury (BITCOIN_TREASURY_KEY, ETHEREUM_TREASURY_KEY) to the server's .env and restart it."
          : "Nibblets get cards from these, within the spending limit you give each one in its settings."}
      </p>
      {providers.map((p) => (
        <div
          key={p.id}
          className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
        >
          {p.state === "ready" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">
              {p.label}
              <span className="ml-1.5 font-normal text-dim">{p.asset.code}</span>
            </span>
            <span className="text-xs break-all text-dim">
              {p.state === "error"
                ? `Can't be reached: ${p.detail ?? "no reason given"}`
                : p.balance !== null
                  ? `${money(p.balance, p.asset)} available`
                  : "Ready"}
            </span>
          </div>
        </div>
      ))}
      {problems.map((p) => (
        <div
          key={p.id}
          className="flex items-start gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
        >
          <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{p.id}</span>
            <span className="text-xs break-all text-dim">Not set up: {p.detail}</span>
          </div>
        </div>
      ))}
    </>
  );
}
