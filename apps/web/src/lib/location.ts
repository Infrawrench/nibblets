import { isTimeZone, type LocationFix, type Nibblet } from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";
import { storage } from "./storage.ts";

/** The platform of the desktop app this page is in, or null in a browser. */
function desktopPlatform(userAgent: string): string | null {
  return /NibbletsDesktop\/(\w+)/.exec(userAgent)?.[1] ?? null;
}

/**
 * Why this page can't ask where the device is, or null when it can.
 * Browsers only give a location to secure pages: https, or this computer.
 */
export function locationUnavailable(
  env: { geolocation: boolean; secure: boolean } = {
    geolocation: typeof navigator !== "undefined" && "geolocation" in navigator,
    secure: typeof window !== "undefined" && window.isSecureContext,
  },
): string | null {
  if (!env.geolocation) return "This browser can't share a location.";
  if (!env.secure)
    return "Browsers only share a location with pages on https or on this computer. Open Nibblets that way, or through Nibblets Connect, to share it.";
  return null;
}

/** What went wrong, and where to fix it, in words. */
export function positionErrorMessage(
  error: Pick<GeolocationPositionError, "code">,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): string {
  const platform = desktopPlatform(userAgent);
  // GeolocationPositionError's codes; the constants aren't there outside a browser.
  if (error.code === 1) {
    if (platform === "darwin")
      return "Nibblets isn't allowed your location. Turn it on in System Settings → Privacy & Security → Location Services.";
    if (platform === "win32")
      return "Nibblets isn't allowed your location. Turn it on in Settings → Privacy & security → Location.";
    return "This page isn't allowed your location. Allow it in the browser's site settings, then try again.";
  }
  if (error.code === 3) return "Finding where you are took too long. Try again.";
  if (platform === "linux")
    return "The desktop app can't find where you are on Linux. Share it from a browser instead.";
  return "This device couldn't work out where it is. Check its location services, or try from another device.";
}

/** The device's own time zone, which goes with its position. */
export function deviceTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isTimeZone(zone) ? zone : null;
}

/** A position from the device, as the server takes it. */
export function toFix(position: Pick<GeolocationPosition, "coords">, timeZone: string | null) {
  const { latitude, longitude, accuracy } = position.coords;
  return {
    latitude,
    longitude,
    accuracyM: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    timeZone,
  } satisfies LocationFix;
}

/**
 * Asks the device where it is. The browser (or the desktop app's OS) asks
 * the person first. A rough fix is plenty for a city, and quicker.
 */
export function currentFix(geolocation: Geolocation = navigator.geolocation): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => resolve(toFix(position, deviceTimeZone())),
      (error) => reject(new Error(positionErrorMessage(error))),
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

/** "Wednesday 14:03", there and now. */
export function localTime(timeZone: string, now = new Date()): string {
  return now.toLocaleString(undefined, {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

const autoKey = (server: string, nibbletId: string) =>
  `nibblet.location.auto.${server}.${nibbletId}`;

/**
 * Whether this device answers a nibblet asking where its person is without
 * asking them. Kept on the device, since it's about where the device goes:
 * a phone that's carried, say, and not a desktop left at home.
 */
export function answersByItself(server: string, nibbletId: string): boolean {
  return storage.get(autoKey(server, nibbletId)) === "1";
}

export function setAnswersByItself(server: string, nibbletId: string, on: boolean): void {
  if (on) storage.set(autoKey(server, nibbletId), "1");
  else storage.remove(autoKey(server, nibbletId));
}

/** The top of a nibblet's tree: its sub-agents go by its setting. */
export function rootOf(nibblets: readonly Pick<Nibblet, "id" | "parentId">[], id: string): string {
  const seen = new Set<string>();
  let current = nibblets.find((n) => n.id === id);
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId: string = current.parentId;
    const parent = nibblets.find((n) => n.id === parentId);
    if (!parent) return parentId;
    current = parent;
  }
  return current?.id ?? id;
}

/** Whether the browser gives this page a position without asking the person first. */
export async function locationGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

/** Answers a nibblet's `location_get` with where this device is now. */
export async function answerFromDevice(
  connection: Pick<ServerConnection, "client">,
  nibbletId: string,
  requestId: string,
): Promise<void> {
  const location = await currentFix();
  await connection.client.nibblets.answerLocation({ id: nibbletId, requestId, location });
}

export function declineLocation(
  connection: Pick<ServerConnection, "client">,
  nibbletId: string,
  requestId: string,
): Promise<unknown> {
  return connection.client.nibblets.answerLocation({ id: nibbletId, requestId, location: null });
}
