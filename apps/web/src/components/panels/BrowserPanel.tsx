import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Hand, Loader2, MousePointerClick, RefreshCw } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import {
  BrowserView,
  listSessions,
  openBrowser,
  pointerButton,
  viewUrl,
  wheelPixels,
  type ViewInput,
  type ViewState,
} from "../../lib/browserView.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { Button } from "../ui/Button.tsx";
import { cn } from "../../lib/cn.ts";

/**
 * The nibblet's browser, live. Watching is always on; input is forwarded
 * only while "Take control" is on, so a stray click can't knock the
 * nibblet off what it's doing.
 */
export function BrowserPanel({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const qc = useQueryClient();
  const sessionsKey = ["browser-sessions", connection.id, nibblet.id];
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: () => listSessions(connection, nibblet.id),
    enabled: nibblet.browser && nibblet.status !== "stopped" && !connection.mock,
    refetchInterval: 5000,
  });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!nibblet.browser) {
    return <Empty>The browser is turned off for {nibblet.name}. Turn it on in Settings.</Empty>;
  }
  if (connection.mock) return <MockBrowser />;
  if (nibblet.status === "stopped")
    return <Empty>{nibblet.name} is asleep. Wake them to use the browser.</Empty>;

  const session = sessions.data?.[0];
  if (!session) {
    return (
      <Empty>
        <Globe className="size-6 text-faint" />
        <span>No browser is open.</span>
        <Button
          variant="primary"
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            setError(null);
            try {
              await openBrowser(connection, nibblet.id);
              await qc.invalidateQueries({ queryKey: sessionsKey });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setOpening(false);
            }
          }}
        >
          {opening ? <Loader2 className="animate-spin" /> : <Globe />}
          Open browser
        </Button>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </Empty>
    );
  }
  return (
    <LiveView
      key={session.session_id}
      connection={connection}
      nibbletId={nibblet.id}
      sessionId={session.session_id}
      onEnded={() => void qc.invalidateQueries({ queryKey: sessionsKey })}
    />
  );
}

function LiveView({
  connection,
  nibbletId,
  sessionId,
  onEnded,
}: {
  connection: ServerConnection;
  nibbletId: string;
  sessionId: string;
  /** The browser was closed: go back to offering to open one. */
  onEnded: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<BrowserView | null>(null);
  const [state, setState] = useState<ViewState>("connecting");
  const [control, setControl] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const v = new BrowserView(viewUrl(connection, nibbletId, sessionId));
    const offs = [
      v.onState((s) => {
        setState(s);
        if (s === "ended") onEnded();
      }),
      v.onFrame((frame) => {
        const el = canvas.current;
        const ctx = el?.getContext("2d");
        if (!el || !ctx) return;
        // Keyframes carry the whole window; anything else is a patch over it.
        if (
          frame.keyframe &&
          (el.width !== frame.windowWidth || el.height !== frame.windowHeight)
        ) {
          el.width = frame.windowWidth;
          el.height = frame.windowHeight;
        }
        ctx.drawImage(frame.bitmap, frame.x, frame.y);
        frame.bitmap.close();
      }),
      v.onMessage((m) => {
        if (m.type === "hello" || m.type === "windows") {
          setTitle(m.windows.find((w) => w.id === m.window)?.title ?? null);
        }
      }),
    ];
    setView(v);
    return () => {
      offs.forEach((off) => off());
      v.close();
    };
  }, [connection, nibbletId, sessionId, generation]);

  /** Canvas pixels from a pointer event, since the canvas is scaled to fit. */
  const toWindow = (e: { clientX: number; clientY: number }) => {
    const el = canvas.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * el.width),
      y: Math.round(((e.clientY - r.top) / r.height) * el.height),
    };
  };
  const send = (input: ViewInput) => {
    if (control) view?.send(input);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span
          className={cn(
            "size-1.5 rounded-full",
            state === "open"
              ? "bg-ok"
              : state === "connecting"
                ? "animate-pulse bg-warning"
                : "bg-danger",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-dim">{title ?? "Browser"}</span>
        {state !== "open" ? (
          <Button
            size="icon"
            variant="ghost"
            title="Reconnect"
            onClick={() => setGeneration((g) => g + 1)}
          >
            <RefreshCw />
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={control ? "primary" : "secondary"}
          onClick={() => setControl((c) => !c)}
        >
          {control ? <Hand /> : <MousePointerClick />}
          {control ? "You're in control" : "Take control"}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-deep p-2">
        <canvas
          ref={canvas}
          tabIndex={0}
          className={cn(
            "max-h-full max-w-full rounded border border-line bg-black/5 shadow-sm outline-none",
            control ? "cursor-default ring-2 ring-accent" : "cursor-not-allowed",
          )}
          onContextMenu={(e) => control && e.preventDefault()}
          onPointerMove={(e) =>
            send({
              type: "pointer",
              action: "move",
              ...toWindow(e),
              button: pointerButton(e.button),
            })
          }
          onPointerDown={(e) => {
            e.currentTarget.focus();
            send({
              type: "pointer",
              action: "down",
              ...toWindow(e),
              button: pointerButton(e.button),
            });
          }}
          onPointerUp={(e) =>
            send({ type: "pointer", action: "up", ...toWindow(e), button: pointerButton(e.button) })
          }
          onWheel={(e) => send({ type: "wheel", ...toWindow(e), ...wheelPixels(e) })}
          onKeyDown={(e) => {
            if (!control || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send({ type: "key", action: "down", code: e.code, key: e.key });
          }}
          onKeyUp={(e) => {
            if (!control) return;
            e.preventDefault();
            send({ type: "key", action: "up", code: e.code, key: e.key });
          }}
          onPaste={(e) => {
            if (!control) return;
            e.preventDefault();
            send({ type: "text", text: e.clipboardData.getData("text") });
          }}
        />
      </div>
      {state === "connecting" ? (
        <div className="p-2 text-center text-2xs text-faint">Connecting…</div>
      ) : null}
    </div>
  );
}

/** A placeholder page so the panel can be judged in mock mode. */
function MockBrowser() {
  const [control, setControl] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="size-1.5 rounded-full bg-ok" />
        <span className="min-w-0 flex-1 truncate text-xs text-dim">
          Gatwick to Lisbon · Flights
        </span>
        <Button
          size="sm"
          variant={control ? "primary" : "secondary"}
          onClick={() => setControl((c) => !c)}
        >
          {control ? <Hand /> : <MousePointerClick />}
          {control ? "You're in control" : "Take control"}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-deep p-2">
        <div
          className={cn(
            "aspect-[16/10] w-full rounded border border-line bg-white p-3 shadow-sm",
            control && "ring-2 ring-accent",
          )}
        >
          <div className="mb-2 h-4 w-2/3 rounded bg-neutral-200" />
          <div className="mb-3 h-6 rounded-full border border-neutral-300 bg-neutral-50" />
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="mb-2 flex items-center gap-2 rounded border border-neutral-200 p-2"
            >
              <div className="size-6 rounded bg-sky-200" />
              <div className="flex-1">
                <div className="mb-1 h-2 w-1/2 rounded bg-neutral-300" />
                <div className="h-2 w-1/3 rounded bg-neutral-200" />
              </div>
              <div className="h-3 w-10 rounded bg-emerald-200" />
            </div>
          ))}
        </div>
      </div>
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
