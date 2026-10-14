import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Check, Loader2, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import type { Nibblet, Snapshot, SnapshotTimeline } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { relativeTime } from "../../lib/time.ts";
import { formatBytes, frequencyOptions, keepCounts, triggerLabel } from "../../lib/snapshots.ts";
import { Button } from "../ui/Button.tsx";
import { FieldRow, Input, SectionHeading, Select } from "../ui/Field.tsx";
import { Modal } from "../ui/Modal.tsx";

const longTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const title = (s: Snapshot) =>
  s.label ?? (s.trigger === "auto" ? "Automatic snapshot" : "Snapshot");

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A nibblet's snapshots as a timeline, newest first: take one, choose how
 * often they're taken automatically, and go back (or forward) to any of them.
 */
export function SnapshotsPanel({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const client = connection.client.snapshots;
  const timeline = useQuery({
    queryKey: keys.snapshots(connection.id, nibblet.id),
    queryFn: () => client.list({ nibbletId: nibblet.id }),
  });
  const [labelling, setLabelling] = useState(false);
  const [label, setLabel] = useState("");
  const [restoring, setRestoring] = useState<Snapshot | null>(null);
  const [deleting, setDeleting] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activity = timeline.data?.activity ?? null;
  const busy = activity !== null;
  const policy = nibblet.snapshotPolicy;
  const setPolicy = (patch: Partial<typeof policy>) =>
    void connection.client.nibblets.update({
      id: nibblet.id,
      snapshotPolicy: { ...policy, ...patch },
    });

  const take = async () => {
    setError(null);
    setLabelling(false);
    try {
      await client.create({ nibbletId: nibblet.id, label: label.trim() || undefined });
      setLabel("");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="flex flex-col gap-1 p-3">
      <SectionHeading
        action={
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLabelling((l) => !l)}>
            <Camera />
            Take snapshot
          </Button>
        }
      >
        Snapshots
      </SectionHeading>
      {labelling ? (
        <form
          className="mb-1 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void take();
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            maxLength={80}
            autoFocus
          />
          <Button type="submit" size="md" variant="primary">
            Take
          </Button>
        </form>
      ) : null}
      {activity ? (
        <p className="flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1.5 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          {activity === "restoring"
            ? "Restoring…"
            : nibblet.status === "working"
              ? `Waiting for ${nibblet.name} to finish, then taking a snapshot…`
              : "Taking a snapshot…"}
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <div className="mt-1 flex flex-col gap-1.5">
        <FieldRow label="Automatically">
          <Select
            className="w-40"
            value={policy.everyMinutes === null ? "off" : String(policy.everyMinutes)}
            onChange={(v) => setPolicy({ everyMinutes: v === "off" ? null : Number(v) })}
            options={frequencyOptions(policy)}
          />
        </FieldRow>
        {policy.everyMinutes !== null ? (
          <FieldRow
            label="Keep"
            hint="Older automatic snapshots are deleted. Ones you take yourself are kept until you delete them."
          >
            <Select
              className="w-40"
              value={String(policy.keep)}
              onChange={(v) => setPolicy({ keep: Number(v) })}
              options={[...new Set([...keepCounts, policy.keep])]
                .sort((a, b) => a - b)
                .map((n) => ({ value: String(n), label: `The newest ${n}` }))}
            />
          </FieldRow>
        ) : null}
      </div>

      <SectionHeading>Timeline</SectionHeading>
      {timeline.data ? (
        <Timeline
          data={timeline.data}
          nibblet={nibblet}
          busy={busy}
          onRestore={setRestoring}
          onDelete={setDeleting}
          onRename={async (s, label) => {
            await client.rename({ id: s.id, label }).catch((err) => setError(errorText(err)));
          }}
        />
      ) : null}

      <details className="mt-3 text-xs text-dim">
        <summary className="cursor-pointer text-faint select-none hover:text-dim">
          How this works
        </summary>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <p>
            A snapshot keeps {nibblet.name}'s files (its home folder), its conversation, its own
            memories, its schedules and heartbeats, and its settings. Its name and look aren't part
            of it, and memories shared between nibblets are left alone.
          </p>
          <p>
            Restoring saves how things are right now as a snapshot first, so you can always roll
            forward again. {nibblet.name} restarts afterwards: programs it had running start fresh,
            because Docker Desktop can't save what's in a container's memory.
          </p>
          <p>
            Snapshots wait for a reply in progress to finish. Automatic ones are skipped when
            nothing has happened since the last snapshot.
          </p>
        </div>
      </details>

      <Modal
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Restore “${title(restoring)}”?` : "Restore"}
        className="w-[min(92vw,440px)]"
      >
        <div className="p-4">
          <p className="text-sm text-dim">
            {nibblet.name} goes back to how it was{" "}
            {restoring ? relativeTime(restoring.createdAt) : ""}: its files, conversation, memories,
            schedules and settings. What it has now is saved as a snapshot first, so you can roll
            forward to it later.
          </p>
          <div className="mt-4 flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => setRestoring(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const target = restoring;
                setRestoring(null);
                if (!target) return;
                setError(null);
                await client.restore({ id: target.id }).catch((err) => setError(errorText(err)));
              }}
            >
              Restore
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this snapshot?"
        className="w-[min(92vw,440px)]"
      >
        <div className="p-4">
          <p className="text-sm text-dim">
            You won't be able to go back to {deleting ? `“${title(deleting)}”` : "it"} any more.{" "}
            {nibblet.name} itself isn't changed.
          </p>
          <div className="mt-4 flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const target = deleting;
                setDeleting(null);
                if (target) {
                  await client.delete({ id: target.id }).catch((err) => setError(errorText(err)));
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Timeline({
  data,
  nibblet,
  busy,
  onRestore,
  onDelete,
  onRename,
}: {
  data: SnapshotTimeline;
  nibblet: Nibblet;
  busy: boolean;
  onRestore: (s: Snapshot) => void;
  onDelete: (s: Snapshot) => void;
  onRename: (s: Snapshot, label: string | null) => Promise<void>;
}) {
  const here = data.current && !data.current.changedSince ? data.current.snapshotId : null;
  const restoredFrom = data.current?.snapshotId ?? null;
  const at = data.snapshots.find((s) => s.id === restoredFrom);

  return (
    <ol className="relative flex flex-col">
      <span className="absolute top-3 bottom-3 left-[7px] w-px bg-line" aria-hidden />
      <li className="relative flex gap-2.5 py-1.5">
        <Dot filled={here === null} />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">Now</span>
          <span className="text-2xs text-faint">
            {here && at
              ? `Same as “${title(at)}”`
              : at
                ? `Restored from “${title(at)}”, changed since`
                : `${nibblet.name} as it is right now`}
          </span>
        </div>
      </li>
      {data.snapshots.length === 0 ? (
        <li className="py-4 pl-7 text-xs text-faint">
          No snapshots yet.
          {nibblet.snapshotPolicy.everyMinutes === null
            ? " Take one to have something to come back to."
            : " The first automatic one is taken once something has happened."}
        </li>
      ) : null}
      {data.snapshots.map((s) => (
        <Row
          key={s.id}
          snapshot={s}
          here={s.id === here}
          busy={busy}
          onRestore={() => onRestore(s)}
          onDelete={() => onDelete(s)}
          onRename={(label) => onRename(s, label)}
        />
      ))}
    </ol>
  );
}

function Dot({ filled }: { filled: boolean }) {
  return (
    <span
      className={cn(
        "relative mt-1 size-[15px] shrink-0 rounded-full border-2",
        filled ? "border-accent bg-accent" : "border-edge bg-panel",
      )}
    />
  );
}

function Row({
  snapshot: s,
  here,
  busy,
  onRestore,
  onDelete,
  onRename,
}: {
  snapshot: Snapshot;
  here: boolean;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
  onRename: (label: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(s.label ?? "");

  return (
    <li className="group relative flex gap-2.5 rounded-md py-1.5 pr-1 hover:bg-hover">
      <Dot filled={here} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <form
            className="flex gap-1"
            onSubmit={async (e) => {
              e.preventDefault();
              await onRename(value.trim() || null);
              setEditing(false);
            }}
          >
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Label"
              maxLength={80}
              autoFocus
              className="h-6 text-xs"
            />
            <Button size="icon" variant="ghost" type="submit" title="Save">
              <Check />
            </Button>
            <Button size="icon" variant="ghost" title="Cancel" onClick={() => setEditing(false)}>
              <X />
            </Button>
          </form>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{title(s)}</span>
            {here ? (
              <span className="shrink-0 rounded-full bg-accent px-1.5 text-2xs font-medium text-accent-text">
                You are here
              </span>
            ) : null}
          </span>
        )}
        <span className="text-2xs text-faint" title={new Date(s.createdAt).toISOString()}>
          {relativeTime(s.createdAt)} · {longTime(s.createdAt)}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-2xs text-faint">
          <span
            className={cn(
              "rounded border px-1",
              s.trigger === "manual"
                ? "border-accent/40 text-accent"
                : s.trigger === "before_restore"
                  ? "border-warning/40 text-warning"
                  : "border-edge",
            )}
          >
            {triggerLabel(s.trigger)}
          </span>
          {formatBytes(s.sizeBytes)} · {s.messageCount}{" "}
          {s.messageCount === 1 ? "message" : "messages"}
        </span>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 pt-0.5">
        <Button size="sm" variant="secondary" disabled={busy || here} onClick={onRestore}>
          <RotateCcw />
          Restore
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Rename"
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            setValue(s.label ?? "");
            setEditing(true);
          }}
        >
          <Pencil />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Delete"
          disabled={busy}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
