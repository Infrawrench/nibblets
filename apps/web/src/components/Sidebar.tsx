import { useState } from "react";
import { useOffline } from "../lib/offline-context.tsx";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Laptop, LogIn, Plus, Settings } from "lucide-react";
import { defaultHamsterLook, type Nibblet, type NibbletStatus } from "@nibblet/protocol";
import { Hamster } from "./hamster/Hamster.tsx";
import { CreateNibbletDialog } from "./CreateNibbletDialog.tsx";
import { Button } from "./ui/Button.tsx";
import { keys, useLiveState, useServer, useServers } from "../lib/servers.tsx";
import { NibbletMenu } from "./NibbletMenu.tsx";
import type { ServerConnection } from "../lib/connection.ts";
import { cn } from "../lib/cn.ts";
import { UpdateBar } from "./UpdateBar.tsx";
import { orderNibblets } from "../lib/nibblets.ts";
import { localServerId } from "../lib/central.ts";

const statusText: Record<NibbletStatus, string> = {
  stopped: "Asleep",
  starting: "Waking",
  idle: "",
  working: "Working",
  waiting: "Out of usage",
  error: "Needs help",
};

const statusDot: Record<NibbletStatus, string> = {
  stopped: "bg-faint/50",
  starting: "bg-warning",
  idle: "bg-dim/50",
  working: "bg-working",
  waiting: "bg-warning",
  error: "bg-danger",
};

export function Sidebar({ className }: { className?: string }) {
  const servers = useServers();
  const offline = useOffline();
  const navigate = useNavigate();
  const onSettings = useRouterState({ select: (r) => r.location.pathname === "/settings" });
  const [creating, setCreating] = useState(false);
  const lists = useQueries({
    queries: servers.systems.map((s) => ({
      queryKey: keys.nibblets(s.id),
      queryFn: () => {
        if (!s.connection) throw new Error("offline");
        return s.connection.client.nibblets.list({});
      },
      enabled: s.connection !== null,
    })),
  });
  // Which computer a nibblet lives on matters once there could be more than one.
  const showSystem = servers.systems.length > 1 || servers.central !== null;
  const loaded = lists.every((l, i) => l.data !== undefined || !servers.systems[i]?.connection);
  const total = lists.reduce((n, l) => n + (l.data?.length ?? 0), 0);

  return (
    <aside
      className={cn(
        "safe-top flex w-64 shrink-0 flex-col border-r border-line bg-panel",
        className,
      )}
    >
      <div className="shell-titlebar shell-inset flex h-11 items-center gap-2 border-b border-line px-3">
        <Hamster look={{ ...defaultHamsterLook, background: "none" }} size={20} cropped />
        <span className="flex-1 text-sm font-semibold tracking-tight">Nibblets</span>
        <Button size="icon" variant="ghost" title="New nibblet" onClick={() => setCreating(true)}>
          <Plus />
        </Button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 py-2">
        {offline.payload.conversations
          .filter((saved) => {
            const index = servers.systems.findIndex((system) => system.id === saved.server);
            return (
              index < 0 ||
              !servers.systems[index]?.connection ||
              (lists[index]?.isError && lists[index]?.error instanceof TypeError)
            );
          })
          .map((saved) => (
            <button
              key={`${saved.server}/${saved.id}`}
              type="button"
              onClick={() =>
                void navigate({
                  to: "/n/$server/$id",
                  params: { server: saved.server, id: saved.id },
                })
              }
              className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-hover"
            >
              <Hamster look={saved.look} size={22} status="stopped" />
              <span className="min-w-0 flex-1 truncate">
                {saved.name}
                <span className="block text-2xs text-faint">
                  {saved.systemName} · Offline saved chat
                </span>
              </span>
            </button>
          ))}
        {servers.central && servers.systems.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-dim">
            No servers yet. Open Settings on a computer running Nibblets and press Connect.
          </div>
        ) : null}
        {servers.systems.length > 0 && loaded && total === 0 ? (
          <EmptyList onCreate={() => setCreating(true)} />
        ) : null}
        {servers.systems.map((system, i) => {
          const c = system.connection;
          const list = lists[i];
          if (!c || !list?.data || list.isError) return null;
          return orderNibblets(list.data).map(({ nibblet, depth }) => (
            <NibbletRow
              key={`${c.id}/${nibblet.id}`}
              server={c.id}
              nibblet={nibblet}
              depth={depth}
              system={showSystem ? system.name : null}
            />
          ));
        })}
        {servers.systems.map((system, i) =>
          !system.connection || lists[i]?.isError ? (
            <div
              key={system.id}
              className="flex items-center gap-1.5 px-2 py-1 text-2xs text-faint"
              title={lists[i]?.isError ? "Couldn't reach this computer" : "Not checking in"}
            >
              <Laptop aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{system.name}</span>
              <span className="shrink-0">· Offline</span>
            </div>
          ) : null,
        )}
      </nav>
      {servers.central === null && localServerId() && servers.all[0] ? (
        <SignInRow connection={servers.all[0]} />
      ) : null}
      <UpdateBar />
      <div className="border-t border-line px-1.5 pt-1.5 safe-bottom-3">
        <button
          type="button"
          onClick={() => void navigate({ to: "/settings" })}
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-dim hover:bg-hover hover:text-text",
            onSettings && "bg-active text-text",
          )}
        >
          <Settings className="size-3.5" />
          Settings
        </button>
      </div>
      <CreateNibbletDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}

function NibbletRow({
  server,
  nibblet,
  depth,
  system,
}: {
  server: string;
  nibblet: Nibblet;
  depth: number;
  /** The computer it's on, when that's worth saying. */
  system: string | null;
}) {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const connection = useServer(server);
  const active = params.server === server && params.id === nibblet.id;
  // A button, not a link: links make the browser show their address on hover.
  const row = (
    <button
      type="button"
      onClick={() => void navigate({ to: "/n/$server/$id", params: { server, id: nibblet.id } })}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      className={cn(
        "group flex min-h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-hover",
        (nibblet.statusText || system) && "py-1",
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
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate",
            active ? "font-medium" : "",
            nibblet.status === "stopped" && "text-dim",
          )}
        >
          {nibblet.name}
        </span>
        {nibblet.statusText ? (
          <span className="truncate text-2xs leading-tight text-faint" title={nibblet.statusText}>
            {nibblet.statusEmoji ? `${nibblet.statusEmoji} ` : ""}
            {nibblet.statusText}
          </span>
        ) : null}
        {system && connection ? <SystemLine connection={connection} name={system} /> : null}
      </span>
      {nibblet.awaitingApproval ? (
        <span className="shrink-0 text-2xs text-warning">Needs approval</span>
      ) : statusText[nibblet.status] ? (
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
    </button>
  );
  return connection ? (
    <NibbletMenu connection={connection} nibblet={nibblet}>
      {row}
    </NibbletMenu>
  ) : (
    row
  );
}

const linkText = { open: "", connecting: "Connecting…", closed: "Disconnected" } as const;

/** A laptop icon and "PogAir-4", and whether it's still connecting. */
function SystemLine({ connection, name }: { connection: ServerConnection; name: string }) {
  const state = useLiveState(connection);
  return (
    <span className="flex min-w-0 items-center gap-1 text-2xs leading-tight text-faint">
      <Laptop aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
      {linkText[state] ? (
        <span className={cn("shrink-0", state === "closed" ? "text-danger" : "text-warning")}>
          · {linkText[state]}
        </span>
      ) : null}
    </span>
  );
}

/**
 * In the desktop app, on this computer's own server after choosing not to
 * sign in: the way back to Nibblets Connect and the other computers.
 */
function SignInRow({ connection }: { connection: ServerConnection }) {
  const status = useQuery({
    queryKey: keys.connect(connection.id),
    queryFn: () => connection.client.connect.status({}),
  });
  if (status.data?.state !== "linked") return null;
  const central = status.data.centralUrl;
  return (
    <div className="px-1.5 pt-1.5">
      <a
        href={central}
        className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-dim hover:bg-hover hover:text-text"
      >
        <LogIn className="size-3.5" />
        Sign in to see other computers
      </a>
    </div>
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
