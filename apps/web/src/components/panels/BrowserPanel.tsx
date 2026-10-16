import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Hand, Loader2, MousePointerClick } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import { listSessions, openBrowser } from "../../lib/browserView.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { Button } from "../ui/Button.tsx";
import { cn } from "../../lib/cn.ts";
import { LiveView } from "./LiveView.tsx";

/**
 * The nibblet's browser, live. Watching is always on; input is forwarded
 * only while "Take control" is on, so a stray click can't knock the
 * nibblet off what it's doing.
 */
export function BrowserPanel({
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
      kind="computer"
      sessionId={session.session_id}
      label="Browser"
      onEnded={() => void qc.invalidateQueries({ queryKey: sessionsKey })}
      popout={popout}
      onPopOut={() =>
        window.open(
          `/browser/${encodeURIComponent(connection.id)}/${encodeURIComponent(nibblet.id)}`,
          `nibblet-browser-${nibblet.id}`,
          "popup,width=1440,height=960",
        )
      }
    />
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
