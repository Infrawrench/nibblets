import { DEFAULT_MACHINE, type MachineChoice } from "@nibblet/protocol";
import type { MachineOption } from "../lib/machines.ts";
import { machineKey } from "../lib/machines.ts";
import { FieldRow, Select } from "./ui/Field.tsx";

/**
 * Where a new nibblet runs: a container unless there's a hypervisor too,
 * in which case its virtual machines are offered beside it. Hidden when a
 * container is all there is.
 */
export function MachinePicker({
  options,
  value,
  onChange,
}: {
  options: readonly MachineOption[];
  value: MachineChoice;
  onChange: (choice: MachineChoice) => void;
}) {
  if (options.length <= 1) return null;
  const chosen = options.find((o) => o.key === machineKey(value));
  return (
    <FieldRow label="Runs in" top={Boolean(chosen?.notes.length)}>
      <Select
        value={machineKey(value)}
        onChange={(key) => onChange(options.find((o) => o.key === key)?.choice ?? DEFAULT_MACHINE)}
        options={options.map((o) => ({
          value: o.key,
          label: o.ready ? o.label : `${o.label} (needs its image made)`,
        }))}
      />
      {chosen?.notes.length ? (
        <span className="flex flex-col gap-0.5 text-xs text-faint">
          {chosen.notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
        </span>
      ) : null}
    </FieldRow>
  );
}
