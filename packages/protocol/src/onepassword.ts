import { z } from "zod";

/**
 * Sharing 1Password vaults with nibblets. Each nibblet that gets any vault
 * gets its own 1Password service account, scoped to exactly the vaults
 * ticked for it, so it can never see anything else. The token lives on the
 * host and only reaches the nibblet's container when it starts.
 */

export const VaultAccess = z.enum(["read", "write"]);
export type VaultAccess = z.infer<typeof VaultAccess>;

export const OnePasswordVault = z.object({
  id: z.string(),
  name: z.string(),
  /** Personal, Private and Employee vaults can't be shared with a service account. */
  shareable: z.boolean(),
});
export type OnePasswordVault = z.infer<typeof OnePasswordVault>;

export const VaultGrant = z.object({ vaultId: z.string(), access: VaultAccess });
export type VaultGrant = z.infer<typeof VaultGrant>;

export const OnePasswordState = z.enum([
  /** No host bridge to ask. */
  "offline",
  /** The 1Password CLI isn't on this computer. */
  "not_installed",
  /** The CLI is there but not connected to the 1Password app. */
  "not_connected",
  "connected",
]);

export const OnePasswordStatus = z.object({
  state: OnePasswordState,
  /** The signed-in account, e.g. "astrid@infrawrench.com on my.1password.com". */
  account: z.string().nullable(),
  vaults: z.array(OnePasswordVault),
  detail: z.string().nullable(),
});
export type OnePasswordStatus = z.infer<typeof OnePasswordStatus>;

/** Which vaults each nibblet may use, keyed by nibblet id. */
export const OnePasswordGrants = z.record(z.string(), z.array(VaultGrant));
export type OnePasswordGrants = z.infer<typeof OnePasswordGrants>;

/** What the runner is told about a nibblet's vaults: names only, never items. */
export const SharedVault = z.object({ name: z.string(), access: VaultAccess });
export type SharedVault = z.infer<typeof SharedVault>;

/** The environment variable carrying a nibblet's vault list (JSON `SharedVault[]`) into its container. */
export const ONEPASSWORD_VAULTS_ENV = "NIBBLET_ONEPASSWORD_VAULTS";
