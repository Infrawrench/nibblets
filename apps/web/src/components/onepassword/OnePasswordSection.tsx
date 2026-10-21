import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Nibblet, VaultGrant } from "@nibblets/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { useNibblets } from "../../lib/servers.tsx";
import { Hamster } from "../hamster/Hamster.tsx";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { OnePasswordLogo } from "./OnePasswordLogo.tsx";
import { useOnePassword } from "./useOnePassword.ts";
import { ConnectSteps, VaultList, VaultToggle } from "./VaultPicker.tsx";

/** The "How this works" note, the one place the mechanics are spelt out. */
function HowItWorks() {
  return (
    <details className="text-2xs text-faint">
      <summary className="cursor-pointer select-none hover:text-dim">How this works</summary>
      <p className="mt-1">
        Each nibblet you share vaults with gets its own 1Password service account that can only open
        those vaults. Its key stays on this computer and is only handed to the nibblet's container
        while it runs. Keys last 30 days and renew themselves; to cut one off early, untick its
        vaults here, or revoke it on 1Password.com under Developer → Service accounts. Nibblets can
        look up logins, read a secret when they need it, and sign you in on the page in their
        browser without seeing the password.
      </p>
    </details>
  );
}

/** Settings: 1Password on this computer, and which nibblets get which vaults, in one place. */
export function OnePasswordSettings({ connection }: { connection: ServerConnection }) {
  const { status, grants, setGrants, refresh } = useOnePassword(connection);
  const nibblets = useNibblets(connection);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const shareable = s?.vaults.filter((v) => v.shareable) ?? [];
  const list = (nibblets.data ?? []).filter((n) => n.parentId === null);

  const change = async (nibblet: Nibblet, next: VaultGrant[]) => {
    setError(null);
    try {
      await setGrants.mutateAsync({ nibbletId: nibblet.id, grants: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <SectionHeading>1Password</SectionHeading>
      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
        <div className="flex items-center gap-2.5">
          <OnePasswordLogo className="size-6" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">
              {s?.state === "connected"
                ? "Connected"
                : status.isPending
                  ? "Checking…"
                  : "Not connected"}
            </span>
            <span className="truncate text-xs text-dim">
              {s?.state === "connected"
                ? (s.account ?? "Signed in")
                : "Let nibblets use the vaults you choose."}
            </span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void refresh()} title="Check again">
            <RefreshCw />
            Check again
          </Button>
        </div>
        {s && s.state !== "connected" ? <ConnectSteps status={s} /> : null}
        {s?.state === "connected" && s.detail ? (
          <p className="text-xs text-warning">{s.detail}</p>
        ) : null}

        {s?.state === "connected" && shareable.length > 0 && list.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-2xs text-faint">
                  <th className="py-1 pr-2 font-medium">Nibblet</th>
                  {shareable.map((v) => (
                    <th key={v.id} className="px-2 py-1 font-medium whitespace-nowrap">
                      {v.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((n) => {
                  const mine = grants.data?.[n.id] ?? [];
                  return (
                    <tr key={n.id} className="border-t border-line">
                      <td className="py-1 pr-2">
                        <span className="flex items-center gap-1.5">
                          <Hamster look={n.look} size={18} decorative />
                          <span className="truncate">{n.name}</span>
                        </span>
                      </td>
                      {shareable.map((v) => (
                        <td key={v.id} className="px-2 py-1">
                          <VaultToggle
                            compact
                            vaultId={v.id}
                            grants={mine}
                            disabled={setGrants.isPending}
                            onChange={(next) => void change(n, next)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {setGrants.isPending ? (
          <p className="text-2xs text-faint">Updating 1Password… it may ask you to approve this.</p>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <HowItWorks />
      </div>
    </>
  );
}

/** One nibblet's vaults in its settings panel; changes save straight away. */
export function NibbletVaults({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const { status, grants, setGrants } = useOnePassword(connection);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  if (!s || s.state === "offline") return null;
  return (
    <>
      <SectionHeading>
        <span className="flex items-center gap-1.5">
          <OnePasswordLogo className="size-3.5" />
          1Password
        </span>
      </SectionHeading>
      {s.state !== "connected" ? (
        <ConnectSteps status={s} />
      ) : (
        <VaultList
          status={s}
          grants={grants.data?.[nibblet.id] ?? []}
          disabled={setGrants.isPending}
          onChange={async (next) => {
            setError(null);
            try {
              await setGrants.mutateAsync({ nibbletId: nibblet.id, grants: next });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}
      {setGrants.isPending ? (
        <p className="text-2xs text-faint">Updating 1Password… it may ask you to approve this.</p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <HowItWorks />
    </>
  );
}

/** The create flow's version: just remembers the choice, applied once the nibblet exists. */
export function NewNibbletVaults({
  connection,
  value,
  onChange,
}: {
  connection: ServerConnection;
  value: VaultGrant[];
  onChange: (grants: VaultGrant[]) => void;
}) {
  const { status } = useOnePassword(connection);
  const s = status.data;
  if (!s || s.state !== "connected" || !s.vaults.some((v) => v.shareable)) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium text-dim">
        <OnePasswordLogo className="size-3.5" />
        1Password vaults it can use
      </span>
      <VaultList status={s} grants={value} onChange={onChange} />
    </div>
  );
}
