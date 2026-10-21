import { z } from "zod";

/** Whether `zone` is an IANA time zone this runtime knows, like `Europe/London`. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const TimeZone = z.string().max(64).refine(isTimeZone, "Not a time zone");

/**
 * Where a device says it is, from the browser's (or the desktop app's)
 * geolocation, with the device's own time zone, since the position alone
 * doesn't give one.
 */
export const LocationFix = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** How far off the position may be, in metres, as the device reported it. */
  accuracyM: z.number().nonnegative().nullable(),
  timeZone: TimeZone.nullable(),
});
export type LocationFix = z.infer<typeof LocationFix>;

/**
 * The place a position is in, from reverse geocoding. Each part is null
 * where the place has none (no postcode at sea, no city in the countryside).
 */
export const Place = z.object({
  /** The suburb, neighbourhood or district. */
  neighbourhood: z.string().nullable(),
  /** The city, town or village. */
  city: z.string().nullable(),
  /** The state, province or region, or the county where there's none. */
  region: z.string().nullable(),
  postcode: z.string().nullable(),
  country: z.string().nullable(),
  /** ISO 3166-1 alpha-2, upper case, like `GB`. */
  countryCode: z.string().nullable(),
});
export type Place = z.infer<typeof Place>;

/**
 * Where the person a nibblet works for is, as they last shared it. `place`
 * is null when the position couldn't be looked up, or lookups are off.
 */
export const NibbletLocation = LocationFix.extend({
  place: Place.nullable(),
  sharedAt: z.iso.datetime(),
});
export type NibbletLocation = z.infer<typeof NibbletLocation>;

/** "Shoreditch, London, England, United Kingdom", dropping parts that repeat. */
export function placeLabel(place: Place): string | null {
  const parts: string[] = [];
  for (const part of [place.neighbourhood, place.city, place.region, place.country]) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "51.5246, -0.0781", to about ten metres. */
export function formatCoordinates(location: Pick<LocationFix, "latitude" | "longitude">): string {
  return `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}
