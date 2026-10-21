import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaultGrant } from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";

const keys = {
  status: (server: string) => ["onepassword", server, "status"] as const,
  grants: (server: string) => ["onepassword", server, "grants"] as const,
};

/** 1Password on a server's computer, which vaults each nibblet has, and a way to change that. */
export function useOnePassword(connection: ServerConnection) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: keys.status(connection.id),
    queryFn: () => connection.client.onePassword.status({}),
    staleTime: 30_000,
  });
  const grants = useQuery({
    queryKey: keys.grants(connection.id),
    queryFn: () => connection.client.onePassword.grants({}),
  });
  const setGrants = useMutation({
    mutationFn: (input: { nibbletId: string; grants: VaultGrant[] }) =>
      connection.client.onePassword.setGrants(input),
    onSuccess: (all) => qc.setQueryData(keys.grants(connection.id), all),
  });
  return {
    status,
    grants,
    setGrants,
    refresh: () => qc.invalidateQueries({ queryKey: ["onepassword", connection.id] }),
  };
}

/** A nibblet's grants with one vault switched on (at an access level) or off. */
export function withVault(
  current: readonly VaultGrant[],
  vaultId: string,
  access: VaultGrant["access"] | null,
): VaultGrant[] {
  const rest = current.filter((g) => g.vaultId !== vaultId);
  return access ? [...rest, { vaultId, access }] : rest;
}
