import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ArrowUpCircle, Download, Loader2, X } from "lucide-react";
import type { ServerConnection } from "../lib/connection.ts";
import { useServers } from "../lib/servers.tsx";
import { storage } from "../lib/storage.ts";
import { useAppUpdate, useInstallApp } from "./UpdatesSection.tsx";

const dismissedKey = (server: string) => `nibblets.update.dismissed.${server}`;

/**
 * Asks once per release, per server: a newer Nibblets is out, here's
 * what's new, update now or later. "Later" waits for the next release; the
 * update stays in Settings either way.
 */
export function UpdatePrompts() {
  const { all, systems } = useServers();
  // Settings shows the update itself.
  const onSettings = useRouterState({ select: (r) => r.location.pathname === "/settings" });
  if (onSettings) return null;
  return (
    // Top right, under the page's header, where it covers nothing you type into.
    <div className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+3.5rem)] right-4 z-30 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {all.map((c) => (
        <UpdatePrompt
          key={c.id}
          connection={c}
          serverName={all.length > 1 ? (systems.find((s) => s.id === c.id)?.name ?? null) : null}
        />
      ))}
    </div>
  );
}

function UpdatePrompt({
  connection,
  serverName,
}: {
  connection: ServerConnection;
  serverName: string | null;
}) {
  const update = useAppUpdate(connection);
  const install = useInstallApp(connection);
  const [dismissed, setDismissed] = useState(() => storage.get(dismissedKey(connection.id)));
  const u = update.data;
  if (!u?.latest || !(u.available || u.updating)) return null;
  if (dismissed === u.latest.version && !u.updating) return null;
  const later = () => {
    if (!u.latest) return;
    storage.set(dismissedKey(connection.id), u.latest.version);
    setDismissed(u.latest.version);
  };
  const notes = u.latest.notes
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"))
    .slice(0, 3);
  return (
    <div className="pointer-events-auto flex flex-col gap-2 rounded-xl border border-edge bg-panel p-3 shadow-float">
      <div className="flex items-start gap-2">
        <span className="text-lg leading-none">🐹</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">
            {u.updating
              ? `Updating to ${u.latest.version}…`
              : `Nibblets ${u.latest.version} is out`}
          </span>
          <span className="text-xs text-faint">
            {serverName ? `On ${serverName}. ` : ""}
            {u.updating ? "The server restarts partway through." : `You have ${u.current}.`}
          </span>
        </div>
        {u.updating ? (
          <Loader2 className="size-4 animate-spin text-dim" />
        ) : (
          <button
            type="button"
            onClick={later}
            className="rounded p-1 text-dim hover:bg-hover hover:text-text"
            aria-label="Later"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {notes.length > 0 && !u.updating ? (
        <ul className="ml-7 list-disc text-xs text-dim marker:text-faint">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {u.updating ? null : (
        <div className="flex items-center justify-end gap-1.5">
          <a
            className="mr-auto text-xs text-dim underline-offset-2 hover:text-text hover:underline"
            href={u.latest.url}
            target="_blank"
            rel="noreferrer"
          >
            What's new
          </a>
          <button
            type="button"
            onClick={later}
            className="h-7 rounded-md px-2.5 text-sm text-dim hover:bg-hover hover:text-text"
          >
            Later
          </button>
          {u.method === "manual" ? null : (
            <button
              type="button"
              onClick={() => install.mutate(u)}
              disabled={install.isPending}
              className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-sm font-medium text-accent-text hover:bg-accent-hover disabled:opacity-50 [&_svg]:size-3.5"
            >
              {u.method === "download" ? <Download /> : <ArrowUpCircle />}
              {u.method === "download" ? "Download" : "Update now"}
            </button>
          )}
        </div>
      )}
      {u.method === "manual" && !u.updating ? (
        <span className="text-xs text-dim">
          Run the installer on that computer again to update.
        </span>
      ) : null}
    </div>
  );
}
