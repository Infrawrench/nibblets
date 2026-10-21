import { describe, expect, it } from "vitest";
import { formatCoordinates, LocationFix, placeLabel, TimeZone } from "./location.ts";

const empty = {
  neighbourhood: null,
  city: null,
  region: null,
  postcode: null,
  country: null,
  countryCode: null,
};

describe("locations", () => {
  it("names a place from the neighbourhood out, without saying anything twice", () => {
    expect(
      placeLabel({
        ...empty,
        neighbourhood: "Shoreditch",
        city: "London",
        region: "England",
        country: "United Kingdom",
      }),
    ).toBe("Shoreditch, London, England, United Kingdom");
    // City-states are their own region, and sometimes their own country.
    expect(placeLabel({ ...empty, city: "Singapore", country: "Singapore" })).toBe("Singapore");
    expect(placeLabel(empty)).toBeNull();
  });

  it("takes only time zones there are", () => {
    expect(TimeZone.safeParse("Europe/London").success).toBe(true);
    expect(TimeZone.safeParse("UTC").success).toBe(true);
    expect(TimeZone.safeParse("Mars/Olympus_Mons").success).toBe(false);
  });

  it("takes only positions on the globe", () => {
    const fix = { latitude: 51.5, longitude: -0.1, accuracyM: 20, timeZone: null };
    expect(LocationFix.safeParse(fix).success).toBe(true);
    expect(LocationFix.safeParse({ ...fix, latitude: 91 }).success).toBe(false);
    expect(LocationFix.safeParse({ ...fix, longitude: -181 }).success).toBe(false);
    expect(LocationFix.safeParse({ ...fix, accuracyM: -1 }).success).toBe(false);
  });

  it("gives coordinates to about ten metres", () => {
    expect(formatCoordinates({ latitude: 51.524612, longitude: -0.078134 })).toBe(
      "51.5246, -0.0781",
    );
  });
});
