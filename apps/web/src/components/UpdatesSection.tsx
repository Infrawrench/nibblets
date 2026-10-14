import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { compareVersions, type AppUpdate, type HarnessUpdate } from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import { keys } from "../lib/servers.tsx";
import { relativeTime } from "../lib/time.ts";
import { HarnessIcon } from "./HarnessIcon.tsx";
import { Button } from "./ui/Button.tsx";
import { FieldRow, SectionHeading } from "./ui/Field.tsx";
import { Switch } from "./ui/Switch.tsx";

/** Whether a newer Nibblets is out for this server, polled while it's updating. */
export function useAppUpdate(connection: ServerConnection) {
  return useQuery({
    queryKey: keys.appUpdate(connection.id),
    queryFn: () => connection.client.updates.app({ refresh: false }),
    refetchInterval: (q) => (q.state.data?.updating ? 3000 : 30 * 60_000),
    // A server that's mid-restart doesn't answer; keep the last answer.
    retry: false,
  });
}

/** Starts the update this server can install itself, or opens the download. */
export function useInstallApp(connection: ServerConnection) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (update: AppUpdate) => {
      if (update.method === "download" || update.method === "manual") {
        if (update.latest) window.open(update.latest.url, "_blank", "noopener");
        return update;
      }
      return connection.client.updates.applyApp({});
    },
    onSuccess: (next) => qc.setQueryData(keys.appUpdate(connection.id), next),
  });
}

export function UpdatesSection({ connection }: { connection: ServerConnection }) {
  return (
    <>
      <SectionHeading>Updates</SectionHeading>
      <AppRow connection={connection} />
      <HarnessRows connection={connection} />
    </>
  );
}

function AppRow({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const update = useAppUpdate(connection);
  const install = useInstallApp(connection);
  const check = useMutation({
    mutationFn: () => connection.client.updates.app({ refresh: true }),
    onSuccess: (next) => qc.setQueryData(keys.appUpdate(connection.id), next),
  });
  const u = update.data;
  return (
    <FieldRow label="Nibblets" top>
      {!u ? (
        <span className="pt-1 text-sm text-faint">
          {update.isError ? "Couldn't check" : "Checking…"}
        </span>
      ) : (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {u.updating ? (
              <span className="flex items-center gap-1.5 text-dim">
                <Loader2 className="size-3.5 animate-spin" />
                Updating to {u.latest?.version}. The server restarts partway through.
              </span>
            ) : u.available && u.latest ? (
              <>
                <span className="flex items-center gap-1.5">
                  <ArrowUpCircle className="size-3.5 text-accent" />
                  {u.latest.version} is out
                  <span className="text-faint">(you have {u.current})</span>
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-dim">
                <CheckCircle2 className="size-3.5 text-ok" />
                {u.current}, up to date
              </span>
            )}
          </div>
          {u.available && u.latest && !u.updating ? (
            <div className="flex flex-wrap gap-1.5">
              {u.method === "manual" ? (
                <span className="text-xs text-dim">
                  To update, run the installer on that computer again.
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => install.mutate(u)}
                  disabled={install.isPending}
                >
                  {u.method === "download" ? <Download /> : <ArrowUpCircle />}
                  {u.method === "download" ? "Download" : "Update now"}
                </Button>
              )}
              <a
                className="inline-flex items-center px-1 text-xs text-dim underline-offset-2 hover:text-text hover:underline"
                href={u.latest.url}
                target="_blank"
                rel="noreferrer"
              >
                What's new
              </a>
            </div>
          ) : null}
          {u.error || install.error ? (
            <span className="text-xs text-danger">
              {u.error ?? (install.error instanceof Error ? install.error.message : null)}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5 text-xs text-faint">
            Checked {relativeTime(u.checkedAt)}
            <button
              type="button"
              className="rounded p-0.5 hover:bg-hover hover:text-text"
              onClick={() => check.mutate()}
              title="Check now"
              aria-label="Check now"
            >
              <RefreshCw className={check.isPending ? "size-3 animate-spin" : "size-3"} />
            </button>
          </span>
        </div>
      )}
    </FieldRow>
  );
}

function HarnessRows({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const key = keys.harnessUpdates(connection.id);
  const status = useQuery({
    queryKey: key,
    queryFn: () => connection.client.updates.harnesses({}),
    refetchInterval: (q) => (q.state.data?.harnesses.some((h) => h.updating) ? 2000 : false),
  });
  const set = (next: Awaited<ReturnType<typeof connection.client.updates.harnesses>>) =>
    qc.setQueryData(key, next);
  const check = useMutation({
    mutationFn: () => connection.client.updates.check({}),
    onSuccess: set,
  });
  const update = useMutation({
    mutationFn: (id?: HarnessUpdate["id"]) => connection.client.updates.updateHarness({ id }),
    onSuccess: set,
  });
  const bundled = useMutation({
    mutationFn: (id: HarnessUpdate["id"]) => connection.client.updates.useBundled({ id }),
    onSuccess: set,
  });
  const auto = useMutation({
    mutationFn: (on: boolean) => connection.client.updates.setAuto({ auto: on }),
    onSuccess: set,
  });
  const data = status.data;
  if (!data) return null;
  return (
    <>
      <FieldRow
        label="Agents"
        top
        hint="Newer releases of each agent, installed without rebuilding anything. Nibblets use them from their next turn."
      >
        <div className="flex flex-col divide-y divide-line rounded-md border border-line">
          {data.harnesses.map((h) => (
            <HarnessRow
              key={h.id}
              h={h}
              onUpdate={() => update.mutate(h.id)}
              onBundled={() => bundled.mutate(h.id)}
              busy={update.isPending || bundled.isPending}
            />
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label="Automatically"
        hint={`Checks every few hours. Last checked ${relativeTime(data.checkedAt)}.`}
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={data.auto}
            onChange={(on) => auto.mutate(on)}
            label="Keep agents up to date"
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            <RefreshCw className={check.isPending ? "animate-spin" : ""} />
            Check now
          </Button>
        </div>
      </FieldRow>
    </>
  );
}

function HarnessRow({
  h,
  onUpdate,
  onBundled,
  busy,
}: {
  h: HarnessUpdate;
  onUpdate: () => void;
  onBundled: () => void;
  busy: boolean;
}) {
  const inUse = h.installed ?? h.bundled;
  const behind = h.latest !== null && inUse !== null && compareVersions(h.latest, inUse) > 0;
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <HarnessIcon harness={h.id} className="size-3.5 shrink-0" />
        <span className="text-sm font-medium">{h.label}</span>
        <span className="text-xs text-dim">{inUse ?? "…"}</span>
        <span className="ml-auto flex items-center gap-1">
          {h.updating ? (
            <span className="flex items-center gap-1.5 text-xs text-dim">
              <Loader2 className="size-3 animate-spin" />
              Installing {h.latest}…
            </span>
          ) : behind ? (
            <Button size="sm" variant="primary" onClick={onUpdate} disabled={busy}>
              Update to {h.latest}
            </Button>
          ) : h.latest ? (
            <span className="flex items-center gap-1 text-xs text-ok">
              <CheckCircle2 className="size-3" />
              Up to date
            </span>
          ) : null}
          {h.installed && !h.updating ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onBundled}
              disabled={busy}
              title={`Go back to ${h.bundled ?? "the built-in version"}`}
            >
              Use built-in
            </Button>
          ) : null}
        </span>
      </div>
      {h.installed && h.bundled ? (
        <span className="text-2xs text-faint">
          Built-in {h.bundled}, updated to {h.installed}
        </span>
      ) : null}
      {h.error ? <span className="text-xs text-danger">{h.error}</span> : null}
    </div>
  );
}
