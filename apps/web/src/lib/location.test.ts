import { describe, expect, it, vi } from "vitest";
import { currentFix, locationUnavailable, positionErrorMessage, toFix } from "./location.ts";

const mac = "Mozilla/5.0 (Macintosh) Chrome/146 NibbletsDesktop/darwin";
const linux = "Mozilla/5.0 (X11; Linux x86_64) Chrome/146 NibbletsDesktop/linux";
const browser = "Mozilla/5.0 (Macintosh) Safari/605";

describe("sharing a location", () => {
  it("says why a page can't ask", () => {
    expect(locationUnavailable({ geolocation: true, secure: true })).toBeNull();
    expect(locationUnavailable({ geolocation: false, secure: true })).toMatch(/can't share/);
    expect(locationUnavailable({ geolocation: true, secure: false })).toMatch(/https/);
  });

  it("points a refusal at the setting that made it", () => {
    expect(positionErrorMessage({ code: 1 }, mac)).toMatch(/System Settings/);
    expect(positionErrorMessage({ code: 1 }, browser)).toMatch(/site settings/);
    expect(positionErrorMessage({ code: 3 }, browser)).toMatch(/too long/);
    expect(positionErrorMessage({ code: 2 }, linux)).toMatch(/from a browser/);
    expect(positionErrorMessage({ code: 2 }, browser)).toMatch(/couldn't work out/);
  });

  it("sends the position with the device's time zone", () => {
    const coords = { latitude: 51.5246, longitude: -0.0781, accuracy: 34.6 };
    expect(toFix({ coords } as GeolocationPosition, "Europe/London")).toEqual({
      latitude: 51.5246,
      longitude: -0.0781,
      accuracyM: 35,
      timeZone: "Europe/London",
    });
  });

  it("turns a failed lookup into words", async () => {
    const geolocation = {
      getCurrentPosition: vi.fn((_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
        fail?.({ code: 3 } as GeolocationPositionError),
      ),
    } as unknown as Geolocation;
    await expect(currentFix(geolocation)).rejects.toThrow(/too long/);
  });
});
