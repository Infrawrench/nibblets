import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Plus, Repeat, Trash2 } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading, Textarea } from "../ui/Field.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import { describeCron, toCron, type Repeat as RepeatRule } from "../../lib/cron.ts";
import { RepeatPicker } from "./RepeatPicker.tsx";

export function SchedulesPanel({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const qc = useQueryClient();
  const key = keys.schedules(connection.id, nibblet.id);
  const schedules = useQuery({
    queryKey: key,
    queryFn: () => connection.client.schedules.list({ nibbletId: nibblet.id }),
  });
  const [adding, setAdding] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  return (
    <div className="flex flex-col gap-1 p-3">
      <SectionHeading
        action={
          <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}>
            <Plus />
            New
          </Button>
        }
      >
        Schedules
      </SectionHeading>
      {adding ? (
        <NewSchedule
          connection={connection}
          nibbletId={nibblet.id}
          onDone={() => {
            setAdding(false);
            void refresh();
          }}
        />
      ) : null}
      {schedules.data?.length === 0 && !adding ? (
        <p className="py-6 text-center text-xs text-faint">
          No schedules. Ask {nibblet.name} to remind you of something, or add one here.
        </p>
      ) : null}
      {schedules.data?.map((s) => (
        <div key={s.id} className="flex items-start gap-2 rounded-md px-1.5 py-2 hover:bg-hover">
          <span className="mt-0.5 text-dim [&_svg]:size-3.5">
            {s.cron ? <Repeat /> : <CalendarClock />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{s.name}</span>
            <span className="truncate text-2xs text-faint">
              {s.cron ? <span title={s.cron}>{describeCron(s.cron)}</span> : "Once"} · next{" "}
              {relativeTime(s.nextRunAt)}
              {s.lastRunAt ? ` · last ${relativeTime(s.lastRunAt)}` : ""}
            </span>
            <span className="line-clamp-2 text-xs text-dim">{s.prompt}</span>
          </div>
          <Switch
            checked={s.enabled}
            label="Enabled"
            onChange={async (enabled) => {
              await connection.client.schedules.setEnabled({ id: s.id, enabled });
              void refresh();
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            title="Delete"
            onClick={async () => {
              await connection.client.schedules.delete({ id: s.id });
              void refresh();
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

function NewSchedule({
  connection,
  nibbletId,
  onDone,
}: {
  connection: ServerConnection;
  nibbletId: string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<"repeat" | "once">("repeat");
  const [name, setName] = useState("");
  const [repeat, setRepeat] = useState<RepeatRule>({ kind: "daily", time: "09:00" });
  const [at, setAt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <form
      className="mb-2 flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await connection.client.schedules.create({
            nibbletId,
            name,
            prompt,
            timezone,
            cron: kind === "repeat" ? toCron(repeat) : null,
            runAt: kind === "once" && at ? new Date(at).toISOString() : null,
          });
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }}
    >
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: "repeat", label: "Repeating" },
          { value: "once", label: "Once" },
        ]}
      />
      <FieldRow label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning summary"
          required
        />
      </FieldRow>
      {kind === "repeat" ? (
        <FieldRow label="Repeats" top>
          <RepeatPicker value={repeat} onChange={setRepeat} timezone={timezone} />
        </FieldRow>
      ) : (
        <FieldRow label="When">
          <Input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            required
          />
        </FieldRow>
      )}
      <FieldRow label="Prompt" top>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should it do?"
          required
        />
      </FieldRow>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={kind === "repeat" && repeat.kind === "weekdays" && repeat.days.length === 0}
        >
          Add schedule
        </Button>
      </div>
    </form>
  );
}
