import { openWeb } from "../lib/links.ts";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Loader2, Network, Unplug, Wifi } from "lucide-react";
import {
  ProxyUrl,
  type ConnectStatus,
  type PublicAddress,
  type RouteKind,
  type ServerRoutes,
  type TailscaleStatus,
} from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import type { ChosenRouteKind } from "../lib/central.ts";
import { keys, useServers } from "../lib/servers.tsx";
import { relativeTime } from "../lib/time.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "./ui/Button.tsx";
import { FieldRow, Input, SectionHeading } from "./ui/Field.tsx";
import { Switch } from "./ui/Switch.tsx";

/*
 * Remote access, after T3 Connect: link a server to your Nibblets account
 * with a code, and it shows up wherever you're signed in, reached directly
 * over the nearest route.
 */

const routeLabels: Record<ChosenRouteKind, string> = {
  local: "this computer",
  lan: "Local network",
  tailscale: "Tailscale",
  tunnel: "Cloudflare Tunnel",
};

const routeIcons: Record<RouteKind, typeof Globe> = {
  lan: Wifi,
  tailscale: Network,
  tunnel: Globe,
};

function routeList(routes: ServerRoutes): { kind: RouteKind; url: string }[] {
  return [
    ...routes.lan.map((url) => ({ kind: "lan" as const, url })),
    ...(routes.tailscale ? [{ kind: "tailscale" as const, url: routes.tailscale }] : []),
    ...(routes.tunnel ? [{ kind: "tunnel" as const, url: routes.tunnel }] : []),
  ];
}

export function RemoteAccessSection({ connection }: { connection: ServerConnection }) {
  return (
    <>
      <SectionHeading>Remote access</SectionHeading>
      <AccountCard connection={connection} />
      <TailscaleRow connection={connection} />
      <ReverseProxyRow connection={connection} />
    </>
  );
}

function AccountCard({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const key = keys.connect(connection.id);
  const status = useQuery({
    queryKey: key,
    queryFn: () => connection.client.connect.status({}),
    // While waiting for approval, and until the first heartbeat lands, check often.
    refetchInterval: (q) => {
      const s = q.state.data;
      return s?.state === "linking" || (s?.state === "linked" && !s.lastHeartbeatAt)
        ? 2000
        : 15_000;
    },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<ConnectStatus>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Globe className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">Nibblets account</span>
          <span className="text-xs text-dim">
            {s?.state === "linked"
              ? `Connected as ${s.account}. This server shows up wherever you sign in.`
              : "Connect this server to your account to see and use its nibblets from anywhere."}
          </span>
        </div>
        {s?.state === "unlinked" ? (
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => connection.client.connect.start({}))}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            Connect
          </Button>
        ) : null}
        {s?.state === "linked" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act(() => connection.client.connect.unlink({}))}
          >
            <Unplug />
            Disconnect
          </Button>
        ) : null}
      </div>

      {s?.state === "linking" ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-edge p-3 text-center">
          <span className="text-2xs tracking-wider text-faint uppercase">Your code</span>
          <span className="font-mono text-2xl font-semibold tracking-[0.2em]">{s.code}</span>
          <span className="text-xs text-dim">
            Approve it on Nibblets Connect, signed in to your account. Waiting
            <Loader2 className="ml-1 inline size-3 animate-spin" />
          </span>
          <div className="flex gap-1.5">
            <Button variant="primary" size="sm" onClick={() => openUrl(s.approveUrl)}>
              <ExternalLink />
              Open approval page
            </Button>
            <Button size="sm" onClick={() => void act(() => connection.client.connect.cancel({}))}>
              Cancel
            </Button>
          </div>
          <span className="text-2xs text-faint">Expires {relativeTime(s.expiresAt)}</span>
        </div>
      ) : null}

      {s?.state === "linked" ? (
        <div className="flex flex-col gap-1">
          {routeList(s.routes).map((r) => {
            const Icon = routeIcons[r.kind];
            return (
              <div key={`${r.kind}${r.url}`} className="flex items-center gap-2 text-xs">
                <Icon className="size-3.5 text-faint" />
                <span className="w-32 shrink-0 text-dim">{routeLabels[r.kind]}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-2xs text-faint"
                  title={r.url}
                >
                  {r.url.replace(/^https?:\/\//, "")}
                </span>
                <Button size="sm" variant="ghost" onClick={() => openUrl(r.url)}>
                  <ExternalLink />
                  Open
                </Button>
              </div>
            );
          })}
          {routeList(s.routes).length === 0 ? (
            <span className="text-xs text-dim">
              <Loader2 className="mr-1 inline size-3 animate-spin" />
              Starting the tunnel…
            </span>
          ) : null}
          <span className={cn("text-2xs", s.lastError ? "text-danger" : "text-faint")}>
            {s.lastError
              ? `Couldn't reach Nibblets Connect: ${s.lastError}`
              : s.lastHeartbeatAt
                ? `Checked in ${relativeTime(s.lastHeartbeatAt)}${s.managedTunnel ? "" : " · quick tunnel (its address changes on restart)"}`
                : "Checking in…"}
          </span>
        </div>
      ) : null}

      {s ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-faint">
            Nibblets Connect · {s.centralUrl.replace(/^https?:\/\//, "")}
          </span>
          <Button size="sm" variant="ghost" onClick={() => openUrl(s.centralUrl)}>
            <ExternalLink />
            Open Nibblets Connect
          </Button>
        </div>
      ) : null}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}

function TailscaleRow({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const key = keys.tailscale(connection.id);
  const status = useQuery({
    queryKey: key,
    queryFn: () => connection.client.tailscale.status({}),
    // While someone's finishing a sign-in or turning Serve on in their browser,
    // or starting Tailscale itself.
    refetchInterval: (q) => (q.state.data?.action ? 3000 : q.state.data?.stopped ? 5000 : false),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<TailscaleStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      qc.setQueryData(key, next);
      if (next.action) openUrl(next.action.url);
      void qc.invalidateQueries({ queryKey: keys.connect(connection.id) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const s = status.data;
  const hint =
    error ??
    (!s
      ? "Checking…"
      : !s.installed
        ? (s.detail ?? "Install Tailscale on this computer to reach it over your tailnet.")
        : s.serving && s.url
          ? s.url
          : (s.detail ?? "Share this server on your tailnet over HTTPS."));
  return (
    <FieldRow label="Tailscale" hint={hint}>
      <div className="flex items-center gap-2">
        {s?.stopped ? (
          <Button
            size="sm"
            disabled={busy || status.isFetching}
            onClick={() => void status.refetch()}
          >
            {status.isFetching ? <Loader2 className="animate-spin" /> : null}
            Check again
          </Button>
        ) : s?.installed && !s.running ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void (s.action
                ? openUrl(s.action.url)
                : run(() => connection.client.tailscale.login({})))
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            {s.action?.label ?? "Sign in to Tailscale"}
          </Button>
        ) : (
          <Switch
            checked={s?.serving ?? false}
            disabled={busy || !s?.running}
            label="Share on Tailscale"
            onChange={(serving) => void run(() => connection.client.tailscale.set({ serving }))}
          />
        )}
        {s?.running && s.action ? (
          <Button size="sm" variant="primary" onClick={() => openUrl(s.action?.url ?? "")}>
            <ExternalLink />
            {s.action.label}
          </Button>
        ) : null}
        {busy ? <Loader2 className="size-3.5 animate-spin text-faint" /> : null}
      </div>
    </FieldRow>
  );
}

/**
 * The person's own reverse proxy, if this server is behind one: where
 * anything that has to reach it from the internet (a card provider asking
 * about a purchase, a pairing link) is told to, over Connect's tunnel.
 */
function ReverseProxyRow({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const key = keys.publicAddress(connection.id);
  const address = useQuery({
    queryKey: key,
    queryFn: () => connection.client.publicAddress.status({}),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = address.data?.proxy ?? "";
  const value = draft ?? saved;
  const save = async (url: string | null) => {
    let next = url;
    if (next !== null) {
      const parsed = ProxyUrl.safeParse(next.trim());
      if (!parsed.success) {
        setError("That should be an https address, like https://nibblets.example.com");
        return;
      }
      next = parsed.data;
    }
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(key, await connection.client.publicAddress.setProxy({ url: next }));
      setDraft(null);
      // Banks show the address to give their providers.
      void qc.invalidateQueries({ queryKey: keys.bank(connection.id) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FieldRow label="Reverse proxy" top hint={error ?? reachedHint(address.data)}>
      <span className="flex gap-1.5">
        <Input
          value={value}
          disabled={busy}
          placeholder="https://nibblets.example.com"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        {saved && value === saved ? (
          <Button size="sm" disabled={busy} onClick={() => void save(null)}>
            Stop using it
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !value.trim()} onClick={() => void save(value)}>
            Use it
          </Button>
        )}
      </span>
    </FieldRow>
  );
}

function reachedHint(address: PublicAddress | undefined): string {
  if (!address) return "Checking…";
  switch (address.via) {
    case "proxy":
      return `Reached from the internet at ${address.url}, rather than through Nibblets Connect.`;
    case "tunnel":
      return `Reached from the internet through Nibblets Connect, at ${address.url}. If it's behind your own reverse proxy, give its address to use that instead.`;
    case "quick_tunnel":
      return `Reached from the internet through a quick tunnel, at ${address.url}, which changes whenever it starts. A reverse proxy's address stays put.`;
    case null:
      return "Not reached from the internet yet. Link it to Nibblets Connect above, or if it's behind your own reverse proxy, give the https address it's reached at.";
  }
}

/** Opens a link outside the app: a new tab, or the desktop app's own browser handling. */
function openUrl(url: string): void {
  openWeb(url);
}

/** Central mode: who's signed in, and the servers on the account. */
export function AccountSection() {
  const { central, systems } = useServers();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  if (!central) return null;
  return (
    <>
      <SectionHeading>Account</SectionHeading>
      <p className="text-xs text-dim">Signed in as {central.user.name}.</p>
      <SectionHeading>Your servers</SectionHeading>
      <p className="text-xs text-faint">
        To add one, open Settings on that server (or the Nibblets app on it) and press Connect.
      </p>
      {systems.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", s.online ? "bg-ok" : "bg-faint")} />
          <div className="flex min-w-0 flex-1 flex-col">
            {renaming?.id === s.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await central.api.rename(s.id, renaming.name.trim());
                  setRenaming(null);
                  central.refresh();
                }}
              >
                <Input
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                  onBlur={() => setRenaming(null)}
                />
              </form>
            ) : (
              <button
                type="button"
                className="truncate text-left text-sm font-medium"
                title="Rename"
                onClick={() => setRenaming({ id: s.id, name: s.name })}
              >
                {s.name}
              </button>
            )}
            <span className="truncate text-2xs text-faint">
              {s.online && s.route ? `Online via ${routeLabels[s.route.kind]}` : "Offline"}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await central.api.remove(s.id);
              central.refresh();
            }}
          >
            Remove
          </Button>
        </div>
      ))}
    </>
  );
}
