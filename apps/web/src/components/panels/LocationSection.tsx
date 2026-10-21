import { useState } from "react";
import { LocateFixed, MapPin } from "lucide-react";
import { formatCoordinates, placeLabel, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "../../lib/connection.ts";
import { currentFix, localTime, locationUnavailable } from "../../lib/location.ts";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { SectionHeading } from "../ui/Field.tsx";

const distance = (metres: number) =>
  metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;

/**
 * Where the person is, shared from this device's location (the browser's, or
 * the desktop app's) when they ask. The server looks up the place it's in,
 * and the nibblet is told it, with their time zone, in every prompt.
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
              ? `${nibblet.name} knows this place and your time zone. Share again when you've moved.`
              : "Tells it where you are (your town, time zone and coordinates) for the weather, local times and what's nearby. Your server looks up the place with OpenStreetMap."}
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
      </div>
    </>
  );
}
