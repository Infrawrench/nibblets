import { isTimeZone, type LocationFix } from "@nibblet/protocol";

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
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 5 * 60_000 },
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
