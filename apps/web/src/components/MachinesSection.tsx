import { useState } from "react";
import { Loader2 } from "lucide-react";
import { GUEST_NAMES, type MachineBackend, type MachineGuest } from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { imageNote, useMachines } from "../lib/machines.ts";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "./ui/Field.tsx";

/**
 * The server's host's hypervisors, for nibblets in virtual machines, and
 * each guest's image: made by itself for Linux, by hand for a guest that
 * needs an installer. Hidden when there are none: containers need nothing here.
 */
export function MachinesSection({ connection }: { connection: ServerConnection }) {
  const machines = useMachines(connection);
  const vms = machines.backends.filter((b) => b.kind === "vm");
  if (vms.length === 0) return null;
  return (
    <>
      <SectionHeading>Virtual machines</SectionHeading>
      <p className="text-xs text-faint">
        Nibblets run in containers unless you choose a virtual machine when you make one. A VM is a
        stronger wall around it, and can run another OS, but starts slower and keeps all its memory.
        Docker still runs the server either way.
      </p>
      {vms.map((backend) => (
        <Hypervisor
          key={backend.id}
          connection={connection}
          backend={backend}
          onChanged={() => void machines.refetch()}
        />
      ))}
    </>
  );
}

function Hypervisor({
  connection,
  backend,
  onChanged,
}: {
  connection: ServerConnection;
  backend: MachineBackend;
  onChanged: () => void;
}) {
  if (!backend.available) {
    return (
      <FieldRow label={backend.name}>
        <span className="text-sm text-dim">{backend.detail ?? "Not available here"}</span>
      </FieldRow>
    );
  }
  return (
    <>
      {backend.guests.map((guest) => (
        <GuestImageRow
          key={guest.os}
          connection={connection}
          backend={backend}
          guest={guest}
          onChanged={onChanged}
        />
      ))}
    </>
  );
}

function GuestImageRow({
  connection,
  backend,
  guest,
  onChanged,
}: {
  connection: ServerConnection;
  backend: MachineBackend;
  guest: MachineGuest;
  onChanged: () => void;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { image } = guest;
  const needsSource = image.source !== "none";
  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      await connection.client.machines.prepare({
        backend: backend.id,
        guest: guest.os,
        ...(needsSource ? { source: source.trim() } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const preparing = image.state === "preparing";
  return (
    <FieldRow
      label={`${GUEST_NAMES[guest.os]} VMs`}
      hint={error ?? imageNote(guest) ?? `Ready, on ${backend.name}.`}
    >
      <span className="flex items-center gap-1.5">
        {needsSource ? (
          <Input
            className="flex-1"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={`Path to a ${GUEST_NAMES[guest.os]} ISO on the server's computer`}
          />
        ) : (
          <span className="flex-1 text-sm">
            {preparing ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                {image.progress === null ? "Making it" : `${Math.round(image.progress * 100)}%`}
              </span>
            ) : image.state === "ready" ? (
              "Ready"
            ) : (
              "Not made yet"
            )}
          </span>
        )}
        <Button
          disabled={busy || preparing || (needsSource && !source.trim())}
          onClick={() => void prepare()}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {image.state === "ready" ? "Make again" : "Make it"}
        </Button>
      </span>
    </FieldRow>
  );
}
