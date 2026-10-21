import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { LocateFixed, MapPin } from "lucide-react";
import type { Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../lib/connection.ts";
import {
  answerFromDevice,
  answersByItself,
  declineLocation,
  locationGranted,
  locationUnavailable,
  rootOf,
  setAnswersByItself,
} from "../lib/location.ts";
import { keys } from "../lib/servers.tsx";
import { Button } from "./ui/Button.tsx";

interface Ask {
  nibbletId: string;
  requestId: string;
}

/**
 * Answers a nibblet's `location_get` from this device. Where the person has
 * let this device answer for that nibblet, and the browser already allows
 * it, it does so by itself; otherwise it asks them, in the nibblet's thread
 * and, anywhere else in the app, in a box over the page. Another device
 * answering first, or the nibblet giving up, takes the question away.
 */
export function LocationResponder({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  const [asks, setAsks] = useState<Ask[]>([]);

  useEffect(() => {
    // Answered before this device got round to asking: don't ask after all.
    const settled = new Set<string>();
    const ask = (next: Ask) =>
      setAsks((all) =>
        settled.has(next.requestId) || all.some((a) => a.requestId === next.requestId)
          ? all
          : [...all, next],
      );
    return connection.live.subscribe((m) => {
      if (m.type !== "item" || m.item.item.type !== "location_request") return;
      const { nibbletId, item } = m.item;
      if (item.status !== "pending") {
        settled.add(item.id);
        setAsks((all) => all.filter((a) => a.requestId !== item.id));
        return;
      }
      if (locationUnavailable() !== null) return;
      const nibblets = qc.getQueryData<Nibblet[]>(keys.nibblets(connection.id)) ?? [];
      const root = rootOf(nibblets, nibbletId);
      void (async () => {
        if (answersByItself(connection.id, root) && (await locationGranted())) {
          try {
            await answerFromDevice(connection, nibbletId, item.id);
            return;
          } catch {
            // Couldn't find itself, or another device was first: ask, if it's still waiting.
          }
        }
        ask({ nibbletId, requestId: item.id });
      })();
    });
  }, [connection, qc]);

  // Looking at that nibblet already, the question in its thread is enough.
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = asks.find((a) => path !== `/n/${connection.id}/${a.nibbletId}`);
  if (!current) return null;
  return (
    <LocationPrompt
      key={current.requestId}
      connection={connection}
      ask={current}
      onDone={() => setAsks((all) => all.filter((a) => a.requestId !== current.requestId))}
    />
  );
}

function LocationPrompt({
  connection,
  ask,
  onDone,
}: {
  connection: ServerConnection;
  ask: Ask;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const nibblets = qc.getQueryData<Nibblet[]>(keys.nibblets(connection.id)) ?? [];
  const name = nibblets.find((n) => n.id === ask.nibbletId)?.name ?? "A nibblet";
  const root = rootOf(nibblets, ask.nibbletId);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (share: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (share) {
        await answerFromDevice(connection, ask.nibbletId, ask.requestId);
        if (always) setAnswersByItself(connection.id, root, true);
      } else {
        await declineLocation(connection, ask.nibbletId, ask.requestId);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`${name} wants to know where you are`}
      className="fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-edge bg-panel p-3 text-sm shadow-float"
    >
      <div className="flex items-start gap-2">
        <MapPin className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="font-medium">{name} wants to know where you are</div>
          <div className="text-xs text-dim">
            It gets where this device is now, and your time zone.
          </div>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-dim">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        Let this device answer by itself next time
      </label>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
          Not now
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void answer(true)}>
          <LocateFixed />
          {busy ? "Finding you…" : "Share"}
        </Button>
      </div>
    </div>
  );
}
