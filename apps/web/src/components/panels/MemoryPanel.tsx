import { useDeferredValue, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, Users } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading, Textarea } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";

export function MemoryPanel({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const memories = useQuery({
    queryKey: keys.memories(connection.id, nibblet.id, deferred),
    queryFn: () =>
      connection.client.memories.list({
        nibbletId: nibblet.id,
        ...(deferred ? { query: deferred } : {}),
      }),
  });
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const [shared, setShared] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["memories", connection.id] });

  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="flex h-7 items-center gap-2 rounded-md border border-edge bg-field px-2">
        <Search className="size-3.5 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search what ${nibblet.name} remembers…`}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </div>
      <SectionHeading
        action={
          <Button size="sm" variant="ghost" onClick={() => setAdding((a) => !a)}>
            <Plus />
            Add note
          </Button>
        }
      >
        {deferred ? "Closest matches" : "Memories"}
      </SectionHeading>
      {adding ? (
        <form
          className="mb-2 flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5"
          onSubmit={async (e) => {
            e.preventDefault();
            await connection.client.memories.create({
              nibbletId: shared ? null : nibblet.id,
              content: note,
              tags: [],
            });
            setNote("");
            setAdding(false);
            void refresh();
          }}
        >
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Something worth remembering"
            required
          />
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2 text-xs text-dim">
              <Switch checked={shared} onChange={setShared} label="Share with every nibblet" />
              Share with every nibblet
            </label>
            <Button size="sm" variant="primary" type="submit">
              Save
            </Button>
          </div>
        </form>
      ) : null}
      {memories.data?.length === 0 ? (
        <p className="py-6 text-center text-xs text-faint">
          {deferred ? "Nothing matches." : "Nothing remembered yet."}
        </p>
      ) : null}
      {memories.data?.map((m) => (
        <div
          key={m.id}
          className="group flex items-start gap-2 rounded-md px-1.5 py-2 hover:bg-hover"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm whitespace-pre-wrap">{m.content}</span>
            <span className="flex items-center gap-1.5 text-2xs text-faint">
              {m.nibbletId === null ? (
                <span className="flex items-center gap-0.5">
                  <Users className="size-3" /> Shared
                </span>
              ) : null}
              {m.tags.map((t) => (
                <span key={t} className="rounded bg-deep px-1">
                  {t}
                </span>
              ))}
              {relativeTime(m.createdAt)}
              {m.score !== null ? ` · ${Math.round(m.score * 100)}% match` : ""}
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            title="Forget"
            className="opacity-0 group-hover:opacity-100"
            onClick={async () => {
              await connection.client.memories.delete({ id: m.id });
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
