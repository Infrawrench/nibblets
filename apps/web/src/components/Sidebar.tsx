import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { Plus, Settings } from "lucide-react";
import { defaultHamsterLook, type Nibblet, type NibbletStatus } from "@nibblet/protocol";
import { Hamster } from "./hamster/Hamster.tsx";
import { CreateNibbletDialog } from "./CreateNibbletDialog.tsx";
import { Button } from "./ui/Button.tsx";
import { keys, useLiveState, useServers } from "../lib/servers.tsx";
import { useServerNames } from "../lib/useServerNames.ts";
import type { ServerConnection } from "../lib/connection.ts";
import { cn } from "../lib/cn.ts";
import { orderNibblets } from "../lib/nibblets.ts";

const statusText: Record<NibbletStatus, string> = {
  stopped: "Asleep",
  starting: "Waking",
  idle: "",
  working: "Working",
  error: "Needs help",
};

const statusDot: Record<NibbletStatus, string> = {
  stopped: "bg-faint/50",
  starting: "bg-warning",
  idle: "bg-dim/50",
  working: "bg-working",
  error: "bg-danger",
};

export function Sidebar() {
  const servers = useServers();
  const names = useServerNames();
  const [creating, setCreating] = useState(false);
  const lists = useQueries({
    queries: servers.all.map((c) => ({
      queryKey: keys.nibblets(c.id),
      queryFn: () => c.client.nibblets.list({}),
    })),
  });
  const grouped = servers.all.length > 1;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="shell-titlebar shell-inset flex h-11 items-center gap-2 border-b border-line px-3">
        <Hamster look={{ ...defaultHamsterLook, background: "none" }} size={22} />
        <span className="flex-1 text-sm font-semibold tracking-tight">Nibblets</span>
        <Button size="icon" variant="ghost" title="New nibblet" onClick={() => setCreating(true)}>
          <Plus />
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {servers.all.map((c, i) => {
          const data = lists[i]?.data;
          return (
            <div key={c.id} className="mb-2">
              {grouped ? <ServerHeading connection={c} name={names.get(c.id) ?? c.id} /> : null}
              {data && data.length === 0 && !grouped ? (
                <EmptyList onCreate={() => setCreating(true)} />
              ) : null}
              {data ? (
                orderNibblets(data).map(({ nibblet, depth }) => (
                  <NibbletRow key={nibblet.id} server={c.id} nibblet={nibblet} depth={depth} />
                ))
              ) : lists[i]?.isError ? (
                <div className="px-2 py-1 text-2xs text-danger">Couldn't reach this server.</div>
              ) : null}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line p-1.5">
        <Link
          to="/settings"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-dim hover:bg-hover hover:text-text [&.active]:bg-active [&.active]:text-text"
        >
          <Settings className="size-3.5" />
          Settings
        </Link>
      </div>
      <CreateNibbletDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}

function ServerHeading({ connection, name }: { connection: ServerConnection; name: string }) {
  const state = useLiveState(connection);
  return (
    <div className="flex h-6 items-center gap-1.5 px-2 text-2xs font-semibold tracking-wider text-faint uppercase">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "open" ? "bg-ok" : state === "connecting" ? "bg-warning" : "bg-danger",
        )}
        title={
          state === "open" ? "Connected" : state === "connecting" ? "Connecting" : "Disconnected"
        }
      />
      <span className="truncate">{name}</span>
    </div>
  );
}

function NibbletRow({
  server,
  nibblet,
  depth,
}: {
  server: string;
  nibblet: Nibblet;
  depth: number;
}) {
  const params = useParams({ strict: false });
  const active = params.server === server && params.id === nibblet.id;
  return (
    <Link
      to="/n/$server/$id"
      params={{ server, id: nibblet.id }}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      className={cn(
        "group flex h-8 items-center gap-2 rounded-md pr-2 text-sm hover:bg-hover",
        active && "bg-active hover:bg-active",
      )}
    >
      <span className="relative shrink-0">
        <Hamster look={nibblet.look} size={depth ? 18 : 22} status={nibblet.status} />
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-[1.5px] border-panel",
            statusDot[nibblet.status],
          )}
        />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          active ? "font-medium" : "",
          nibblet.status === "stopped" && "text-dim",
        )}
      >
        {nibblet.name}
      </span>
      {statusText[nibblet.status] ? (
        <span
          className={cn(
            "shrink-0 text-2xs",
            nibblet.status === "working"
              ? "text-working"
              : nibblet.status === "error"
                ? "text-danger"
                : "text-faint",
          )}
        >
          {statusText[nibblet.status]}
        </span>
      ) : null}
    </Link>
  );
}

function EmptyList({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-dim">
      <Hamster look={{ ...defaultHamsterLook, background: "none" }} size={48} status="stopped" />
      No nibblets yet.
      <Button size="sm" variant="primary" onClick={onCreate}>
        <Plus />
        Make one
      </Button>
    </div>
  );
}
