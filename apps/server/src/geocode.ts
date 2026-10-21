import type { Place } from "@nibblets/protocol";
import { z } from "zod";

/**
 * The parts of a Nominatim `reverse` answer we use. Which address keys are
 * there depends on the place: a city has `city`, a smaller place `town` or
 * `village`, and so on.
 */
const NominatimReverse = z.object({
  address: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});

const first = (address: Record<string, string>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = address[key]?.trim();
    if (value) return value;
  }
  return null;
};

/** A Nominatim address as a `Place`, or null when it has nothing we can use. */
export function toPlace(address: Record<string, string>): Place | null {
  const place: Place = {
    // A quarter before a neighbourhood: in Japan, say, that's "Jinnan" rather than "Jinnan 1".
    neighbourhood: first(address, ["suburb", "quarter", "neighbourhood", "city_district"]),
    city: first(address, ["city", "town", "village", "hamlet", "municipality"]),
    region: first(address, ["state", "province", "region", "state_district", "county"]),
    postcode: first(address, ["postcode"]),
    country: first(address, ["country"]),
    countryCode: first(address, ["country_code"])?.toUpperCase() ?? null,
  };
  return Object.values(place).some((v) => v !== null) ? place : null;
}

export interface GeocoderOptions {
  /** Nominatim's base URL; empty turns lookups off. */
  url: string;
  version: string;
  fetch?: typeof fetch;
  /** How long to leave between requests. */
  spacingMs?: number;
}

/**
 * Looks up the place a position is in, with Nominatim: OpenStreetMap's own
 * by default, or another instance, such as one of the person's own. Its
 * usage policy asks for at most one request a second and a User-Agent that
 * says who's asking, so lookups go one at a time, a second apart.
 *
 * The position is rounded to about a hundred metres before it's sent, and
 * asked about at suburb level (`zoom=14`), so the answer never names a street.
 */
export class Geocoder {
  private readonly opts: GeocoderOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(opts: GeocoderOptions) {
    this.opts = opts;
  }

  get enabled(): boolean {
    return this.opts.url !== "";
  }

  /** The place, or null when there's none, lookups are off, or Nominatim couldn't be asked. */
  place(latitude: number, longitude: number): Promise<Place | null> {
    if (!this.enabled) return Promise.resolve(null);
    const next = this.queue.then(() => this.lookup(latitude, longitude));
    this.queue = next.catch(() => undefined);
    return next.catch((err: unknown) => {
      console.warn(`reverse geocoding failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  }

  private async lookup(latitude: number, longitude: number): Promise<Place | null> {
    const wait = this.last + (this.opts.spacingMs ?? 1000) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const url = new URL(
      "reverse",
      this.opts.url.endsWith("/") ? this.opts.url : `${this.opts.url}/`,
    );
    url.search = new URLSearchParams({
      format: "jsonv2",
      lat: latitude.toFixed(3),
      lon: longitude.toFixed(3),
      zoom: "14",
      addressdetails: "1",
      "accept-language": "en",
    }).toString();
    const res = await (this.opts.fetch ?? fetch)(url, {
      headers: {
        "user-agent": `Nibblets/${this.opts.version} (+https://nibblets.dev)`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = NominatimReverse.parse(await res.json());
    // "Unable to geocode": out at sea, say.
    if (body.error || !body.address) return null;
    return toPlace(body.address);
  }
}
