import { useEffect, useState } from "react";
import { LocateFixed, MapPin } from "lucide-react";
import { formatCoordinates, placeLabel, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import {
  answersByItself,
  currentFix,
  localTime,
  locationUnavailable,
  setAnswersByItself,
} from "../../lib/location.ts";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";
import { Switch } from "../ui/Switch.tsx";

const distance = (metres: number) =>
  metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;

/**
 * Where the person is, shared from this device's location (the browser's, or
 * the desktop app's) when they ask, and whether this device answers the
 * nibblet's `location_get` by itself. The server looks up the place.
 */
export function LocationSection({
  connection,
  nibblet,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
}) {
  const [busy, setBusy] = useState<"share" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [auto, setAuto] = useState(() => answersByItself(connection.id, nibblet.id));
  useEffect(() => setAuto(answersByItself(connection.id, nibblet.id)), [connection.id, nibblet.id]);
  const unavailable = locationUnavailable();
  const location = nibblet.location;
  const label = location?.place ? placeLabel(location.place) : null;

  const share = async () => {
    setBusy("share");
    setError(null);
    setNote(null);
    try {
      const fix = await currentFix();
      const updated = await connection.client.nibblets.update({ id: nibblet.id, location: fix });
      const zone = updated.location?.timeZone;
      // Its container's clock is set when it's made.
      if (zone && zone !== location?.timeZone && nibblet.status !== "stopped" && !nibblet.parentId)
        setNote(`Its container's clock changes to ${zone} when it next restarts.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy("forget");
    setError(null);
    setNote(null);
    try {
      await connection.client.nibblets.update({ id: nibblet.id, location: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionHeading>Location</SectionHeading>
      <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-xs">
        {location ? (
          <div className="flex gap-2">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{label ?? formatCoordinates(location)}</div>
              <div className="text-dim">
                {location.place?.postcode ? `${location.place.postcode} · ` : ""}
                {formatCoordinates(location)}
                {location.accuracyM !== null ? ` (±${distance(location.accuracyM)})` : ""}
                {label ? "" : " · the place couldn't be looked up"}
              </div>
              <div className="text-dim">
                {location.timeZone
                  ? `${location.timeZone}, ${localTime(location.timeZone)} there · `
                  : ""}
                shared {relativeTime(location.sharedAt)}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <MapPin className="size-3.5 text-faint" />
            <span className="flex-1 text-dim">
              {nibblet.parentId ? "Its parent's, if it has one" : "Not shared"}
            </span>
          </div>
        )}
        {error || note || unavailable ? (
          <p className={error ? "text-danger" : "text-faint"}>{error ?? note ?? unavailable}</p>
        ) : null}
        <div className="flex items-center gap-2 pt-0.5">
          <p className="flex-1 text-faint">
            {location
              ? `Where you last were. ${nibblet.name} asks your device again when it needs to know.`
              : "When it needs to know where you are (for the weather, local times, what's nearby), it asks an open Nibblets on your device. Your server finds the place with OpenStreetMap."}
          </p>
          {location ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void forget()}
            >
              Forget
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={busy !== null || unavailable !== null}
            onClick={() => void share()}
            title="Share where this device is"
          >
            <LocateFixed />
            {busy === "share" ? "Finding you…" : location ? "Update" : "Share my location"}
          </Button>
        </div>
        {nibblet.parentId || unavailable ? null : (
          <div className="flex items-center gap-2 border-t border-line pt-2">
            <span className="flex-1 text-dim">
              Answer from this device without asking me
              <span className="block text-faint">
                For a device you carry. It still needs the browser's permission.
              </span>
            </span>
            <Switch
              checked={auto}
              onChange={(on) => {
                setAnswersByItself(connection.id, nibblet.id, on);
                setAuto(on);
              }}
              label="Answer from this device without asking me"
            />
          </div>
        )}
      </div>
    </>
  );
}
