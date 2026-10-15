import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2, Plus, ScrollText, Square, SquareTerminal } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { keys } from "../../lib/servers.tsx";
import { describeTask, TerminalSocket, type TerminalState } from "../../lib/terminal.ts";
import { relativeTime } from "../../lib/time.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";

/** What the terminal shows: a shell, or a background task's output. */
type View = { taskId: string | null; generation: number };

/**
 * A terminal in the nibblet's container, as the user it runs as, and the
 * background tasks it started with `task_start`, each of which can be
 * watched or stopped from here.
 */
export function TerminalPanel({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const qc = useQueryClient();
  const asleep = nibblet.status === "stopped";
  const key = keys.tasks(connection.id, nibblet.id);
  const tasks = useQuery({
    queryKey: key,
    queryFn: () => connection.client.nibblets.tasks({ id: nibblet.id }),
    enabled: !asleep,
    refetchInterval: 3000,
  });
  const [view, setView] = useState<View | null>(null);
  const show = (taskId: string | null) =>
    setView((v) => ({ taskId, generation: (v?.generation ?? 0) + 1 }));

  if (connection.mock) return <Empty>Terminals need a real nibblet server.</Empty>;
  if (asleep) return <Empty>{nibblet.name} is asleep. Wake them to open a terminal.</Empty>;

  const list = tasks.data ?? [];
  const watching = view?.taskId ? list.find((t) => t.id === view.taskId) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex max-h-[40%] shrink-0 flex-col overflow-y-auto px-3 pb-2">
        <SectionHeading>Background tasks</SectionHeading>
        {list.length === 0 ? (
          <p className="py-2 text-xs text-faint">
            None. When {nibblet.name} starts a server or a watcher, it shows up here.
          </p>
        ) : null}
        {list.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-hover",
              view?.taskId === t.id && "bg-active",
            )}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                t.status === "running" ? "bg-ok" : t.exitCode ? "bg-danger" : "bg-faint",
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{t.name}</span>
              <span className="truncate text-2xs text-faint" title={`${t.command}\nin ${t.cwd}`}>
                {describeTask(t)} · {relativeTime(t.endedAt ?? t.startedAt)} · {t.command}
              </span>
            </div>
            <Button size="icon" variant="ghost" title="Watch its output" onClick={() => show(t.id)}>
              <ScrollText />
            </Button>
            {t.status === "running" ? (
              <Button
                size="icon"
                variant="ghost"
                title="Stop it"
                onClick={async () => {
                  await connection.client.nibblets.stopTask({ id: nibblet.id, taskId: t.id });
                  void qc.invalidateQueries({ queryKey: key });
                }}
              >
                <Square />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-3">
        <span className="flex-1 truncate text-2xs font-semibold tracking-wider text-faint uppercase">
          {view === null
            ? "Terminal"
            : view.taskId
              ? `Output of ${watching?.name ?? view.taskId}`
              : "Shell"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => show(null)}>
          <Plus />
          New shell
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-deep">
        {view ? (
          <TerminalView
            key={`${view.taskId ?? "shell"}-${view.generation}`}
            connection={connection}
            nibbletId={nibblet.id}
            taskId={view.taskId}
            onRestart={() => show(view.taskId)}
          />
        ) : (
          <Empty>
            <SquareTerminal className="size-6 text-faint" />
            <span>
              A shell in {nibblet.name}'s container, as the same user it works as. What you start
              here stops when you close it; ask {nibblet.name} to start servers as background tasks
              to keep them running.
            </span>
            <Button variant="primary" onClick={() => show(null)}>
              <SquareTerminal />
              Open a shell
            </Button>
          </Empty>
        )}
      </div>
    </div>
  );
}

function TerminalView({
  connection,
  nibbletId,
  taskId,
  onRestart,
}: {
  connection: ServerConnection;
  nibbletId: string;
  taskId: string | null;
  onRestart: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ state: TerminalState; detail?: string }>({
    state: "connecting",
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFromPage(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const socket = new TerminalSocket({
      output: (data) => term.write(data),
      state: (s, detail) => setState({ state: s, detail }),
    });
    void socket.open(connection, nibbletId, { cols: term.cols, rows: term.rows }, taskId);
    const typing = term.onData((data) => socket.input(data));
    const resizing = term.onResize(({ cols, rows }) => socket.resize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    // Follow the page between light and dark.
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => (term.options.theme = themeFromPage());
    scheme.addEventListener("change", retheme);
    term.focus();
    return () => {
      scheme.removeEventListener("change", retheme);
      observer.disconnect();
      typing.dispose();
      resizing.dispose();
      socket.close();
      term.dispose();
    };
  }, [connection, nibbletId, taskId]);

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full p-1.5" />
      {state.state !== "open" ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-line bg-panel px-3 py-1.5 text-xs text-dim">
          {state.state === "connecting" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Connecting…
            </>
          ) : (
            <>
              <span className="flex-1">{state.detail ?? "Ended."}</span>
              <Button size="sm" onClick={onRestart}>
                {taskId ? "Watch again" : "New shell"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The terminal in the page's own colours, light or dark. */
function themeFromPage(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--deep"),
    foreground: v("--text"),
    cursor: v("--text"),
    selectionBackground: v("--accent-soft"),
  };
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-dim">
      {children}
    </div>
  );
}
