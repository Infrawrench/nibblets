import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Download, Loader2 } from "lucide-react";
import { compareVersions, type AppUpdate } from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { keys, useServers } from "../lib/servers.tsx";
import { openWeb } from "../lib/links.ts";
import { cn } from "../lib/cn.ts";

/** Where to get the app by hand: the site leads with the right download. */
const DOWNLOAD_PAGE = "https://nibblets.dev";

interface Pending {
  connection: ServerConnection;
  update: AppUpdate;
}

/**
 * At the bottom of the sidebar when a newer Nibblets is out: one click
 * updates every server that can update itself (a Mac app restarts into the
 * new version, its server with it) and opens the download for any that
 * can't. The details stay in Settings.
 */
export function UpdateBar() {
  const { all } = useServers();
  const qc = useQueryClient();
  const results = useQueries({
    queries: all.map((connection) => ({
      queryKey: keys.appUpdate(connection.id),
      queryFn: () => connection.client.updates.app({ refresh: false }),
      refetchInterval: (q: { state: { data?: AppUpdate } }) =>
        q.state.data?.updating ? 3000 : 30 * 60_000,
      retry: false,
    })),
  });
  const pending: Pending[] = all.flatMap((connection, i) => {
    const update = results[i]?.data;
    return update?.latest && (update.available || update.updating) ? [{ connection, update }] : [];
  });
  const install = useMutation({
    mutationFn: async (items: Pending[]) => {
      let download = false;
      for (const { connection, update } of items) {
        if (update.updating) continue;
        if (update.method === "here") {
          const next = await connection.client.updates.applyApp({});
          qc.setQueryData(keys.appUpdate(connection.id), next);
        } else if (update.method === "download") {
          download = true;
        }
      }
      if (download) openWeb(DOWNLOAD_PAGE);
    },
  });

  if (pending.length === 0) return null;
  const newest = pending
    .map((p) => p.update.latest?.version ?? "")
    .sort(compareVersions)
    .at(-1);
  const updating = install.isPending || pending.some((p) => p.update.updating);
  const canClick = pending.some((p) => p.update.method !== "manual");
  const error = install.error?.message ?? pending.find((p) => p.update.error)?.update.error ?? null;
  const onlyDownloads = pending.every((p) => p.update.method === "download");

  return (
    <div className="px-1.5 pt-1.5">
      <button
        type="button"
        disabled={updating || !canClick}
        onClick={() => install.mutate(pending)}
        title={canClick ? undefined : "Run the installer on that computer again to update."}
        className={cn(
          "flex w-full items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-left text-sm font-medium text-accent-text hover:bg-accent-hover disabled:hover:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0",
          !canClick && "opacity-60",
        )}
      >
        {updating ? (
          <Loader2 className="animate-spin" />
        ) : onlyDownloads ? (
          <Download />
        ) : (
          <ArrowUpCircle />
        )}
        <span className="min-w-0 flex-1 truncate">
          {updating
            ? `Updating to ${newest}…`
            : `${onlyDownloads ? "Download" : "Update to"} Nibblets ${newest}`}
        </span>
        {pending.length > 1 && !updating ? (
          <span className="shrink-0 text-xs opacity-80">{pending.length} servers</span>
        ) : null}
      </button>
      {updating ? (
        <p className="px-2 pt-1 text-xs text-faint">It restarts partway through.</p>
      ) : error ? (
        <p className="px-2 pt-1 text-xs text-danger" title={error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
