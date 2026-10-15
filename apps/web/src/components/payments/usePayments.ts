import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentPermission, SpendPeriod } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";

/** The server's payment accounts and the providers more can be added with. */
export function usePaymentAccounts(connection: ServerConnection) {
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ["payments", connection.id, "providers"],
    queryFn: () => connection.client.payments.providers({}),
    staleTime: Infinity,
  });
  const accounts = useQuery({
    queryKey: keys.paymentAccounts(connection.id),
    queryFn: () => connection.client.payments.accounts({}),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["payments", connection.id] });
  const remove = useMutation({
    mutationFn: (id: string) => connection.client.payments.removeAccount({ id }),
    onSuccess: refresh,
  });
  return { providers, accounts, remove, refresh };
}

/** One nibblet's limit, access and cards, and ways to change them. */
export function useNibbletPayments(connection: ServerConnection, nibbletId: string) {
  const qc = useQueryClient();
  const key = keys.payments(connection.id, nibbletId);
  const overview = useQuery({
    queryKey: key,
    queryFn: () => connection.client.payments.nibblet({ nibbletId }),
  });
  const setPolicy = useMutation({
    mutationFn: (patch: {
      limitCents?: number;
      period?: SpendPeriod;
      access?: Record<string, PaymentPermission>;
    }) => connection.client.payments.setPolicy({ nibbletId, ...patch }),
    onSuccess: (next) => qc.setQueryData(key, next),
  });
  const cancelCard = useMutation({
    mutationFn: (id: string) => connection.client.payments.cancelCard({ id }),
    onSuccess: (next) => qc.setQueryData(key, next),
  });
  return { overview, setPolicy, cancelCard };
}

/** "12.50" or "$12.50" to cents; null when it isn't an amount. */
export function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Cents as an editable amount, without the symbol: "12.50", "40". */
export function moneyInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
