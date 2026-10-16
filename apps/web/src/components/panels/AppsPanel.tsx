import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, LayoutGrid, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { DesktopApp, Nibblet } from "@nibblet/protocol";
import { endSession, launchApp, listSessions, type OcuSession } from "../../lib/browserView.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { hostOf } from "../../lib/nibblets.ts";
import { keys, useNibblets } from "../../lib/servers.tsx";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { LiveView } from "./LiveView.tsx";

/**
 * The apps on the nibblet's desktop, which it and the user share: what's
 * open (whoever opened it), each one live, and a launcher for what's
 * installed in its container.
 */
export function AppsPanel({
  connection,
  nibblet,
  popout = false,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  /** In a window of its own: fills it, and sizes the display to match. */
  popout?: boolean;
}) {
  const qc = useQueryClient();
  const nibblets = useNibblets(connection);
  // The desktop is its container's: a sub-agent's is its host's, and comes with the host's browser.
  const host = hostOf(nibblet, nibblets.data ?? []);
  const asleep = nibblet.status === "stopped";
  const live = host.browser && !asleep && !connection.mock;
  const sessionsKey = ["desktop-sessions", connection.id, nibblet.id];
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: () => listSessions(connection, nibblet.id, "desktop"),
    enabled: live,
    // The nibblet opens and closes apps too, and nothing says when.
    refetchInterval: 3000,
  });
  const appsKey = keys.apps(connection.id, nibblet.id);
  const apps = useQuery({
    queryKey: appsKey,
    queryFn: () => connection.client.nibblets.apps({ id: nibblet.id }),
    // Kept current by the live socket, which passes on what each scan finds.
    enabled: host.browser && !asleep,
  });
  // null: the newest app that's open, or the launcher when nothing is.
  const [selected, setSelected] = useState<string | "launcher" | null>(null);
  const [notice, setNotice] = useState<{ kind: "pending" | "error"; message: string } | null>(null);

  if (!host.browser) {
    return (
      <Empty>
        {host.id === nibblet.id
          ? `Apps come with the browser, which is turned off for ${nibblet.name}. Turn it on in Settings.`
          : `${nibblet.name} uses ${host.name}'s apps, which come with ${host.name}'s browser. It's turned off in ${host.name}'s settings.`}
      </Empty>
    );
  }
  if (asleep) return <Empty>{nibblet.name} is asleep. Wake them to use their apps.</Empty>;

  const open = [...(sessions.data ?? [])].sort((a, b) => opened(a) - opened(b));
  const catalog = apps.data ?? [];
  const current =
    selected === "launcher"
      ? null
      : (open.find((s) => s.session_id === selected) ?? (selected === null ? open.at(-1) : null));
  const refresh = () => void qc.invalidateQueries({ queryKey: sessionsKey });

  const launch = async (app: DesktopApp) => {
    if (connection.mock) {
      setNotice({ kind: "error", message: "Opening apps needs a real nibblet server." });
      return;
    }
    setNotice({ kind: "pending", message: `Opening ${app.name}…` });
    try {
      const session = await launchApp(connection, nibblet.id, app);
      setNotice(null);
      setSelected(session.session_id);
      refresh();
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex max-h-[35%] shrink-0 flex-col overflow-y-auto px-3 pb-2">
        <SectionHeading>Open on {nibblet.name}'s desktop</SectionHeading>
        {open.length === 0 ? (
          <p className="py-2 text-xs text-faint">
            {sessions.isError
              ? sessions.error.message
              : `Nothing yet. Apps you or ${nibblet.name} open show up here.`}
          </p>
        ) : null}
        {open.map((s) => (
          <OpenApp
            key={s.session_id}
            session={s}
            app={appFor(s, catalog)}
            active={current?.session_id === s.session_id}
            onSelect={() => setSelected(s.session_id)}
            onClose={async () => {
              await endSession(connection, nibblet.id, "desktop", s.session_id).catch(
                (err: unknown) =>
                  setNotice({
                    kind: "error",
                    message: err instanceof Error ? err.message : String(err),
                  }),
              );
              if (selected === s.session_id) setSelected(null);
              refresh();
            }}
          />
        ))}
      </div>
      <div className="min-h-0 flex-1 border-t border-line">
        {current ? (
          <LiveView
            key={current.session_id}
            connection={connection}
            nibbletId={nibblet.id}
            kind="desktop"
            sessionId={current.session_id}
            label={appFor(current, catalog)?.name ?? current.session.app}
            onEnded={() => {
              setSelected(null);
              refresh();
            }}
            popout={popout}
            onPopOut={() =>
              window.open(
                `/apps/${encodeURIComponent(connection.id)}/${encodeURIComponent(nibblet.id)}`,
                `nibblet-apps-${nibblet.id}`,
                "popup,width=1440,height=960",
              )
            }
            actions={
              <Button
                size="icon"
                variant="ghost"
                title="Open an app"
                onClick={() => setSelected("launcher")}
              >
                <LayoutGrid />
              </Button>
            }
          />
        ) : (
          <Launcher
            apps={catalog}
            loading={apps.isPending}
            notice={notice}
            onLaunch={(app) => void launch(app)}
            onRescan={() => void qc.invalidateQueries({ queryKey: appsKey })}
            onBack={open.length > 0 ? () => setSelected(null) : undefined}
            nibbletName={nibblet.name}
          />
        )}
      </div>
    </div>
  );
}

/** When a session was opened, as a number to sort by: OpenComputerUse counts them in its ids (`s12-…`). */
function opened(session: OcuSession): number {
  return Number(/^s(\d+)-/.exec(session.session_id)?.[1] ?? 0);
}

/** Which installed app a session is, near enough: OpenComputerUse names it after its command. */
function appFor(session: OcuSession, apps: readonly DesktopApp[]): DesktopApp | undefined {
  const name = session.session.app;
  return apps.find((a) => a.command === name || a.command.split("/").at(-1) === name);
}

function AppIcon({ app, className }: { app: DesktopApp | undefined; className: string }) {
  if (app?.icon)
    return <img src={app.icon} alt="" aria-hidden className={cn("object-contain", className)} />;
  return (
    <span
      aria-hidden
      className={cn("flex items-center justify-center rounded-md bg-deep text-faint", className)}
    >
      {app ? app.name.slice(0, 1).toUpperCase() : <AppWindow className="size-1/2" />}
    </span>
  );
}

function OpenApp({
  session,
  app,
  active,
  onSelect,
  onClose,
}: {
  session: OcuSession;
  app: DesktopApp | undefined;
  active: boolean;
  onSelect: () => void;
  onClose: () => Promise<void>;
}) {
  const [closing, setClosing] = useState(false);
  const title = session.windows[0]?.title;
  const name = app?.name ?? session.session.app;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover",
        active && "bg-active",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
      >
        <AppIcon app={app} className="size-6 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          {title && title !== name ? (
            <span className="truncate text-2xs text-faint">{title}</span>
          ) : null}
        </span>
      </button>
      <Button
        size="icon"
        variant="ghost"
        title={`Close ${name}`}
        disabled={closing}
        onClick={async () => {
          setClosing(true);
          await onClose();
          setClosing(false);
        }}
      >
        {closing ? <Loader2 className="animate-spin" /> : <X />}
      </Button>
    </div>
  );
}

function Launcher({
  apps,
  loading,
  notice,
  onLaunch,
  onRescan,
  onBack,
  nibbletName,
}: {
  apps: DesktopApp[];
  loading: boolean;
  notice: { kind: "pending" | "error"; message: string } | null;
  onLaunch: (app: DesktopApp) => void;
  onRescan: () => void;
  /** Back to what's open, when something is. */
  onBack: (() => void) | undefined;
  nibbletName: string;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((a) =>
      [a.name, a.comment, a.id, ...a.categories].some((f) => f?.toLowerCase().includes(needle)),
    );
  }, [apps, query]);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-deep px-2 py-1.5">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </label>
        <Button size="icon" variant="ghost" title="Look for apps again" onClick={onRescan}>
          <RefreshCw />
        </Button>
        {onBack ? (
          <Button size="icon" variant="ghost" title="Back to what's open" onClick={onBack}>
            <X />
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "flex items-center gap-1.5 text-xs",
            notice.kind === "error" ? "text-danger" : "text-dim",
          )}
        >
          {notice.kind === "pending" ? <Loader2 className="size-3 animate-spin" /> : null}
          {notice.message}
        </p>
      ) : null}
      {apps.length === 0 ? (
        <Empty>
          {loading ? (
            <Loader2 className="size-5 animate-spin text-faint" />
          ) : (
            <>
              <LayoutGrid className="size-6 text-faint" />
              <span>
                No desktop apps are installed in {nibbletName}'s container. Ask {nibbletName} to add
                one: it can put an app (an AppImage, say) in its home folder, with a desktop entry,
                and it shows up here.
              </span>
            </>
          )}
        </Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-1.5">
          {shown.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                onClick={() => onLaunch(app)}
                disabled={notice?.kind === "pending"}
                title={app.comment ?? app.id}
                className="flex w-full items-center gap-2.5 rounded-md border border-line bg-panel p-2 text-left hover:bg-hover disabled:opacity-60"
              >
                <AppIcon app={app} className="size-8 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{app.name}</span>
                  <span className="truncate text-2xs text-faint">
                    {app.comment ?? app.categories.join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-dim">
      {children}
    </div>
  );
}
