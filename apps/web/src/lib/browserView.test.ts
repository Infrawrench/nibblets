import { describe, expect, it } from "vitest";
import { parseFrameHeader, pointerButton, wheelPixels } from "./browserView.ts";

describe("parseFrameHeader", () => {
  it("reads OCU's 20-byte little-endian header", () => {
    const buf = new ArrayBuffer(24);
    const v = new DataView(buf);
    v.setUint8(0, 1);
    v.setUint8(1, 2);
    v.setUint16(2, 1, true);
    v.setUint32(4, 77, true);
    v.setUint16(8, 10, true);
    v.setUint16(10, 20, true);
    v.setUint16(12, 30, true);
    v.setUint16(14, 40, true);
    v.setUint16(16, 1280, true);
    v.setUint16(18, 800, true);
    const frame = parseFrameHeader(buf);
    expect(frame).toMatchObject({
      mime: "image/png",
      keyframe: true,
      windowId: 77,
      x: 10,
      y: 20,
      windowWidth: 1280,
      windowHeight: 800,
    });
    expect(frame?.image.byteLength).toBe(4);
  });

  it("ignores short or unknown messages", () => {
    expect(parseFrameHeader(new ArrayBuffer(8))).toBeNull();
    expect(parseFrameHeader(new ArrayBuffer(20))).toBeNull();
  });
});

describe("input helpers", () => {
  it("maps buttons and wheel units", () => {
    expect(pointerButton(2)).toBe(2);
    expect(pointerButton(4)).toBe(0);
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 120 });
  });
});
