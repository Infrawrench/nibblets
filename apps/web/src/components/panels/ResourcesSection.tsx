import { useQuery } from "@tanstack/react-query";
import { DEFAULT_MEMORY_MB, type Nibblet, type Resources } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { FieldRow, SectionHeading, Select } from "../ui/Field.tsx";

const cpuSteps = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const memorySteps = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 65536, 131072];

const gb = (mb: number) => `${mb / 1024 >= 1 ? +(mb / 1024).toFixed(1) : mb / 1024} GB`;

/** CPU and memory limits for one nibblet, offered up to what the machine has. */
export function ResourcesSection({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const info = useQuery({
    queryKey: keys.info(connection.id),
    queryFn: () => connection.client.system.info({}),
  });
  const host = info.data?.host ?? null;
  const set = (patch: Partial<Resources>) =>
    void connection.client.nibblets.update({
      id: nibblet.id,
      resources: { ...nibblet.resources, ...patch },
    });

  const cpus = nibblet.resources.cpus;
  const cpuOptions = [
    { value: "none", label: host ? `No limit (up to ${host.cpus})` : "No limit" },
    ...cpuSteps
      .filter((n) => !host || n <= host.cpus || n === cpus)
      .map((n) => ({ value: String(n), label: `${n} ${n === 1 ? "CPU" : "CPUs"}` })),
  ];

  const memory = nibblet.resources.memoryMb;
  const memoryOptions = [
    { value: "default", label: `Default (${gb(DEFAULT_MEMORY_MB)})` },
    ...memorySteps
      .filter((mb) => !host || mb <= host.memoryMb || mb === memory)
      .map((mb) => ({ value: String(mb), label: gb(mb) })),
  ];

  return (
    <>
      <SectionHeading>Resources</SectionHeading>
      <FieldRow label="CPU" hint="Its share of the processors Docker has.">
        <Select
          className="w-48"
          value={cpus === null ? "none" : String(cpus)}
          onChange={(v) => set({ cpus: v === "none" ? null : Number(v) })}
          options={cpuOptions}
        />
      </FieldRow>
      <FieldRow
        label="Memory"
        hint={
          host
            ? `Docker has ${gb(host.memoryMb)} to share out. Changes apply straight away.`
            : "Changes apply straight away."
        }
      >
        <Select
          className="w-48"
          value={memory === null ? "default" : String(memory)}
          onChange={(v) => set({ memoryMb: v === "default" ? null : Number(v) })}
          options={memoryOptions}
        />
      </FieldRow>
    </>
  );
}
