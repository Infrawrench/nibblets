import { describe, expect, it, vi } from "vitest";
import { Geocoder, toPlace } from "./geocode.ts";

const shoreditch = {
  suburb: "Shoreditch",
  city: "London",
  state_district: "Greater London",
  state: "England",
  "ISO3166-2-lvl4": "GB-ENG",
  postcode: "E2 7DG",
  country: "United Kingdom",
  country_code: "gb",
};

const answer = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => Response.json(body, { status }));

describe("toPlace", () => {
  it("picks the parts a person would name", () => {
    expect(toPlace(shoreditch)).toEqual({
      neighbourhood: "Shoreditch",
      city: "London",
      region: "England",
      postcode: "E2 7DG",
      country: "United Kingdom",
      countryCode: "GB",
    });
  });

  it("takes a town or village where there's no city, and a county where there's no state", () => {
    expect(
      toPlace({
        village: "Grasmere",
        county: "Westmorland and Furness",
        country: "United Kingdom",
      }),
    ).toMatchObject({ neighbourhood: null, city: "Grasmere", region: "Westmorland and Furness" });
  });

  it("names the district people use, where there's no suburb", () => {
    // Nominatim's answer for Shibuya.
    const shibuya = {
      neighbourhood: "Jinnan 1",
      quarter: "Jinnan",
      city: "Shibuya",
      "ISO3166-2-lvl4": "JP-13",
      postcode: "150-0041",
      country: "Japan",
      country_code: "jp",
    };
    expect(toPlace(shibuya)).toMatchObject({
      neighbourhood: "Jinnan",
      city: "Shibuya",
      region: null,
      countryCode: "JP",
    });
  });

  it("is null for an address with nothing in it", () => {
    expect(toPlace({})).toBeNull();
    expect(toPlace({ city: "  " })).toBeNull();
  });
});

describe("Geocoder", () => {
  it("asks Nominatim about a rounded position, at suburb level, saying who's asking", async () => {
    const fetch = answer({ address: shoreditch });
    const geocoder = new Geocoder({
      url: "https://nominatim.example/",
      version: "1.2.3",
      fetch,
      spacingMs: 0,
    });
    const place = await geocoder.place(51.524612, -0.078134);
    expect(place?.city).toBe("London");
    const [url, init] = fetch.mock.calls[0] ?? [];
    const asked = new URL(String(url));
    expect(asked.origin + asked.pathname).toBe("https://nominatim.example/reverse");
    expect(asked.searchParams.get("lat")).toBe("51.525");
    expect(asked.searchParams.get("lon")).toBe("-0.078");
    expect(asked.searchParams.get("zoom")).toBe("14");
    expect(new Headers(init?.headers).get("user-agent")).toBe(
      "Nibblets/1.2.3 (+https://nibblets.dev)",
    );
  });

  it("keeps a base URL's own path", async () => {
    const fetch = answer({ address: shoreditch });
    await new Geocoder({ url: "https://maps.example/nominatim", version: "1", fetch }).place(0, 0);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/maps\.example\/nominatim\/reverse\?/,
    );
  });

  it("is null, without asking, when lookups are off", async () => {
    const fetch = answer({ address: shoreditch });
    const geocoder = new Geocoder({ url: "", version: "1", fetch });
    expect(geocoder.enabled).toBe(false);
    expect(await geocoder.place(51.5, -0.1)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is null when there's nothing there, or Nominatim can't be asked", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = { url: "https://nominatim.example", version: "1", spacingMs: 0 };
    const sea = new Geocoder({ ...opts, fetch: answer({ error: "Unable to geocode" }) });
    expect(await sea.place(0, -30)).toBeNull();
    const limited = new Geocoder({ ...opts, fetch: answer({}, 429) });
    expect(await limited.place(51.5, -0.1)).toBeNull();
    const down = new Geocoder({
      ...opts,
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await down.place(51.5, -0.1)).toBeNull();
    // A failed lookup doesn't hold up the next.
    expect(await down.place(51.5, -0.1)).toBeNull();
    expect(quiet).toHaveBeenCalledTimes(3);
    quiet.mockRestore();
  });

  it("leaves a gap between lookups, as Nominatim's policy asks", async () => {
    const times: number[] = [];
    const timed = vi.fn<typeof fetch>(async () => {
      times.push(Date.now());
      return Response.json({ address: shoreditch });
    });
    const geocoder = new Geocoder({
      url: "https://n.example",
      version: "1",
      fetch: timed,
      spacingMs: 60,
    });
    await Promise.all([geocoder.place(1, 1), geocoder.place(2, 2), geocoder.place(3, 3)]);
    expect(timed).toHaveBeenCalledTimes(3);
    const [a = 0, b = 0, c = 0] = times;
    expect(b - a).toBeGreaterThanOrEqual(55);
    expect(c - b).toBeGreaterThanOrEqual(55);
  });
});
