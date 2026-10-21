/**
 * How much of a screen is lit, from a screenshot in PPM (`P6`), which is
 * what QEMU's screendump saves unless asked for PNG: a header, then a byte
 * each of red, green and blue per pixel. Windows' boot prompt and its logo
 * are a few lit pixels on black; setup's own screens are mostly lit.
 */
export function litFraction(ppm: Uint8Array): number {
  // "P6", the width, the height and the largest value, each after whitespace.
  const header = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(
    new TextDecoder("latin1").decode(ppm.subarray(0, 64)),
  );
  if (!header) return 0;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = ppm.subarray(header[0].length);
  if (width * height === 0 || pixels.length < width * height * 3) return 0;
  let lit = 0;
  for (let i = 0; i < width * height * 3; i += 3) {
    if (Math.max(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0) > 40) lit++;
  }
  return lit / (width * height);
}
