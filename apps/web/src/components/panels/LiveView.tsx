import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Hand, MousePointerClick, RefreshCw } from "lucide-react";
import {
  BrowserView,
  pointerButton,
  viewUrl,
  wheelPixels,
  type ComputerKind,
  type OcuWindow,
  type ViewInput,
  type ViewState,
} from "../../lib/browserView.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { Button } from "../ui/Button.tsx";
import { cn } from "../../lib/cn.ts";

/**
 * One OpenComputerUse session, live: the browser, or an app on the desktop.
 * Watching is always on; input is forwarded only while "Take control" is
 * on, so a stray click can't knock the nibblet off what it's doing.
 */
export function LiveView({
  connection,
  nibbletId,
  kind,
  sessionId,
  label,
  onEnded,
  popout,
  onPopOut,
  actions,
}: {
  connection: ServerConnection;
  nibbletId: string;
  kind: ComputerKind;
  sessionId: string;
  /** What to call it until its window has a title. */
  label: string;
  /** It was closed: go back to offering to open one. */
  onEnded: () => void;
  popout: boolean;
  onPopOut?: () => void;
  /** More buttons for the bar, before "Take control". */
  actions?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<BrowserView | null>(null);
  const [state, setState] = useState<ViewState>("connecting");
  // Popping it out is a request to use it, so start in control.
  const [control, setControl] = useState(popout);
  const [windows, setWindows] = useState<OcuWindow[]>([]);
  const [watching, setWatching] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const v = new BrowserView(viewUrl(connection, nibbletId, sessionId, kind));
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
          // Chromium is restarted on a blank page if every tab is closed, and
          // an app's dialog can close under it: follow the window that's
          // left rather than sit on an empty view.
          const first = m.windows[0];
          if (m.window === null && first) v.send({ type: "window", id: first.id });
          setWindows(m.windows);
          setWatching(m.window ?? first?.id ?? null);
        }
      }),
    ];
    setView(v);
    return () => {
      offs.forEach((off) => off());
      v.close();
    };
  }, [connection, nibbletId, kind, sessionId, generation]);

  // A pop-out window sizes the display to itself, so the app is drawn at
  // the size it's shown rather than shrunk to fit.
  useEffect(() => {
    if (!popout || !view || state !== "open") return;
    const el = stage.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = Math.max(640, Math.min(4096, Math.floor(el.clientWidth)));
        const height = Math.max(400, Math.min(4096, Math.floor(el.clientHeight)));
        view.send({ type: "resize", width, height });
      }, 250);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [popout, view, state]);

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
  const title = windows.find((w) => w.id === watching)?.title || label;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state === "open"
              ? "bg-ok"
              : state === "connecting"
                ? "animate-pulse bg-warning"
                : "bg-danger",
          )}
        />
        {windows.length > 1 ? (
          // A dialog or a second window: the view shows one at a time.
          <select
            className="min-w-0 flex-1 truncate bg-transparent text-xs text-dim outline-none"
            value={watching ?? ""}
            title="Which window to show"
            onChange={(e) => {
              const id = Number(e.target.value);
              setWatching(id);
              view?.send({ type: "window", id });
            }}
          >
            {windows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title || label}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-dim">{title}</span>
        )}
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
        {actions}
        {popout || !onPopOut ? null : (
          <Button size="icon" variant="ghost" title="Open in its own window" onClick={onPopOut}>
            <ExternalLink />
          </Button>
        )}
        <Button
          size="sm"
          variant={control ? "primary" : "secondary"}
          onClick={() => setControl((c) => !c)}
        >
          {control ? <Hand /> : <MousePointerClick />}
          {control ? "You're in control" : "Take control"}
        </Button>
      </div>
      <div
        ref={stage}
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center bg-deep",
          popout ? "overflow-hidden" : "p-2",
        )}
      >
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
