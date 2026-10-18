import { describe, expect, it } from "vitest";
import { litFraction } from "../src/screen.ts";

/** A PPM screenshot, `width` by `height`, with `lit` pixels of `colour` and the rest black. */
function ppm(width: number, height: number, lit: number, colour: [number, number, number]) {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < lit; i++) pixels.set(colour, i * 3);
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header);
  out.set(pixels, header.length);
  return out;
}

describe("how much of a screen is lit", () => {
  it("is little for a boot prompt's white text on black", () => {
    expect(litFraction(ppm(100, 100, 150, [255, 255, 255]))).toBeCloseTo(0.015);
  });

  it("is most of it for setup's blue", () => {
    expect(litFraction(ppm(100, 100, 9000, [0, 90, 160]))).toBeGreaterThan(0.5);
  });

  it("is none for something that isn't a screenshot", () => {
    expect(litFraction(new TextEncoder().encode("not a picture"))).toBe(0);
  });
});
