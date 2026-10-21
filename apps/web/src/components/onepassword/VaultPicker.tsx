import type { OnePasswordStatus, VaultGrant } from "@nibblets/protocol";
import { cn } from "../../lib/cn.ts";
import { withVault } from "./useOnePassword.ts";

/** Ticking a vault, then choosing whether the nibblet may also change it. */
export function VaultToggle({
  vaultId,
  grants,
  onChange,
  disabled,
  compact,
}: {
  vaultId: string;
  grants: readonly VaultGrant[];
  onChange: (grants: VaultGrant[]) => void;
  disabled?: boolean;
  /** For the grid: no labels, just the box and a small R/W switch. */
  compact?: boolean;
}) {
  const grant = grants.find((g) => g.vaultId === vaultId);
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="checkbox"
        className="size-3.5 accent-[var(--color-accent)]"
        checked={grant !== undefined}
        disabled={disabled}
        aria-label="Can use this vault"
        onChange={(e) => onChange(withVault(grants, vaultId, e.target.checked ? "read" : null))}
      />
      {grant ? (
        <button
          type="button"
          disabled={disabled}
          title={grant.access === "write" ? "Can read and change items" : "Can only read items"}
          onClick={() =>
            onChange(withVault(grants, vaultId, grant.access === "write" ? "read" : "write"))
          }
          className={cn(
            "rounded border px-1 text-2xs font-medium",
            grant.access === "write"
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-line bg-deep text-dim",
          )}
        >
          {compact
            ? grant.access === "write"
              ? "R/W"
              : "R"
            : grant.access === "write"
              ? "Read and change"
              : "Read only"}
        </button>
      ) : null}
    </span>
  );
}

/** One nibblet's vaults as a list, for its settings panel and the create flow. */
export function VaultList({
  status,
  grants,
  onChange,
  disabled,
}: {
  status: OnePasswordStatus;
  grants: readonly VaultGrant[];
  onChange: (grants: VaultGrant[]) => void;
  disabled?: boolean;
}) {
  const shareable = status.vaults.filter((v) => v.shareable);
  if (shareable.length === 0) {
    return <p className="text-xs text-faint">There are no vaults that can be shared yet.</p>;
  }
  return (
    <div className="flex flex-col">
      {shareable.map((v) => (
        <div
          key={v.id}
          className="flex min-h-7 items-center gap-2 rounded-md px-1.5 hover:bg-hover"
        >
          <span className="flex-1 truncate text-sm">{v.name}</span>
          <VaultToggle vaultId={v.id} grants={grants} onChange={onChange} disabled={disabled} />
        </div>
      ))}
    </div>
  );
}

/** What to do when 1Password isn't usable yet, in plain words. */
export function ConnectSteps({ status }: { status: OnePasswordStatus }) {
  if (status.state === "offline") {
    return (
      <p className="text-xs text-dim">This server can't reach the computer it runs on right now.</p>
    );
  }
  if (status.state === "not_installed") {
    return (
      <p className="text-xs text-dim">
        Install the 1Password app and its command-line tool on this computer (on a Mac:{" "}
        <code>brew install 1password-cli</code>), then come back here.
      </p>
    );
  }
  return (
    <ol className="list-decimal pl-4 text-xs text-dim">
      <li>Open the 1Password app and unlock it.</li>
      <li>Go to Settings → Developer.</li>
      <li>Turn on "Integrate with 1Password CLI".</li>
      <li>Come back here and press Check again. 1Password may ask you to allow access.</li>
    </ol>
  );
}
