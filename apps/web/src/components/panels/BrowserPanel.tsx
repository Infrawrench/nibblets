import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Hand, KeyRound, Loader2, LogIn, MousePointerClick, Network } from "lucide-react";
import type { BrowserBorrow, Nibblet } from "@nibblet/protocol";
import { keys, useBorrow } from "../../lib/servers.tsx";
import { listSessions, openBrowser } from "../../lib/browserView.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { useCapabilities } from "../../lib/machines.ts";
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
  const borrow = useBorrow(connection, nibblet.id);

  if (!nibblet.browser) {
    return <Empty>The browser is turned off for {nibblet.name}. Turn it on in Settings.</Empty>;
  }
  if (connection.mock) return <MockBrowser />;
  // A local sign-in stops the nibblet on purpose, so this comes before "asleep".
  if (borrow.data) {
    return <BorrowView connection={connection} nibblet={nibblet} borrow={borrow.data} />;
  }
  if (nibblet.status === "stopped")
    return (
      <Empty>
        <span>{nibblet.name} is asleep. Wake them to use the browser.</span>
        <SignInLocally connection={connection} nibblet={nibblet} />
      </Empty>
    );

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
        <SignInLocally connection={connection} nibblet={nibblet} />
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
      actions={popout ? null : <SignInLocally connection={connection} nibblet={nibblet} compact />}
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

/**
 * Borrows the nibblet's browser profile onto this computer: it stops, its
 * profile opens in a Chrome window here to sign in quickly (with the host's
 * 1Password if it's installed), and closing the window hands it back with
 * every extension purged. Not offered over Nibblets Connect from another
 * computer (the window opens where the server runs), nor for a machine that
 * can't lend its profile out (a VM, for now).
 */
function SignInLocally({
  connection,
  nibblet,
  compact = false,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const can = useCapabilities(connection, nibblet);
  const start = useMutation({
    mutationFn: () => connection.client.nibblets.browserBorrowStart({ id: nibblet.id }),
    onSuccess: (borrow) => qc.setQueryData(keys.borrow(connection.id, nibblet.id), borrow),
  });
  if (!can.localSignIn) return null;
  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        size={compact ? "sm" : "md"}
        variant="secondary"
        disabled={start.isPending}
        title="Open this profile in a Chrome window on this computer to sign in, then hand it back"
        onClick={() => start.mutate()}
      >
        {start.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
        Sign in locally
      </Button>
      {start.error ? (
        <span className="max-w-xs text-center text-2xs text-danger">
          {start.error instanceof Error ? start.error.message : String(start.error)}
        </span>
      ) : null}
    </div>
  );
}

const BORROW_BLURB: Record<BrowserBorrow["state"], string> = {
  preparing: "Stopping the nibblet and copying its profile to this computer…",
  local:
    "Signed in locally. Finish signing in in the Chrome window on this computer, then close it to hand the profile back.",
  handback: "Purging extensions and handing the profile back…",
};

function BorrowView({
  connection,
  nibblet,
  borrow,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  borrow: BrowserBorrow;
}) {
  const end = useMutation({
    mutationFn: () => connection.client.nibblets.browserBorrowEnd({ id: nibblet.id }),
  });
  const busy = borrow.state !== "local";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <LogIn className="size-7 text-accent" />
      <div className="max-w-md space-y-2">
        <p className="text-sm text-dim">{BORROW_BLURB[borrow.state]}</p>
        {borrow.detail ? <p className="text-xs text-danger">{borrow.detail}</p> : null}
      </div>
      {borrow.state === "local" ? (
        <div className="flex max-w-md flex-col gap-1.5 text-xs text-faint">
          {borrow.onePassword ? (
            <span className="flex items-center justify-center gap-1.5">
              <KeyRound className="size-3.5" /> 1Password is in the window; it's purged before
              hand-back.
            </span>
          ) : null}
          {borrow.proxyPort ? (
            <span className="flex items-center justify-center gap-1.5">
              <Network className="size-3.5" /> The window browses through the nibblet's connection.
            </span>
          ) : null}
        </div>
      ) : null}
      <Button
        variant="secondary"
        disabled={busy || end.isPending}
        title="Close the window and throw away the local sign-in"
        onClick={() => end.mutate()}
      >
        {end.isPending ? <Loader2 className="animate-spin" /> : null}
        Cancel and discard
      </Button>
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
