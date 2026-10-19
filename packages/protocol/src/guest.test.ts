import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  encodeSerial,
  HYPERV_AGENT_PORT,
  hypervServiceId,
  SerialReader,
  type SerialFrame,
} from "./guest.ts";

const bytes = (...n: number[]) => new Uint8Array(n);
const message = (text: string): SerialFrame => ({ kind: "message", text });
const data = (channel: number, ...n: number[]): SerialFrame => ({
  kind: "data",
  frame: encodeFrame(channel, bytes(...n)),
});

describe("channel frames", () => {
  it("round-trips a channel and its bytes", () => {
    expect(decodeFrame(encodeFrame(0x8000_0001, bytes(1, 2, 3)))).toEqual({
      channel: 0x8000_0001,
      data: bytes(1, 2, 3),
    });
  });

  it("refuses a frame too short to name a channel", () => {
    expect(decodeFrame(bytes(1, 2))).toBeNull();
  });
});

describe("SerialReader", () => {
  it("reads frames back however the bytes are split", () => {
    const stream = new Uint8Array([
      ...encodeSerial(message('{"type":"hello"}')),
      ...encodeSerial(data(7, 9, 8, 7)),
      ...encodeSerial(message("é")),
    ]);
    for (const size of [1, 2, 5, stream.byteLength]) {
      const reader = new SerialReader();
      const out: SerialFrame[] = [];
      for (let i = 0; i < stream.byteLength; i += size) {
        out.push(...reader.push(stream.subarray(i, i + size)));
      }
      expect(out).toEqual([message('{"type":"hello"}'), data(7, 9, 8, 7), message("é")]);
    }
  });

  it("finds its place again after joining halfway through a frame", () => {
    const whole = encodeSerial(message("lost"));
    const reader = new SerialReader();
    const out = reader.push(
      new Uint8Array([...whole.subarray(3), 0x4e, ...encodeSerial(message("found"))]),
    );
    expect(out).toEqual([message("found")]);
  });

  it("skips a header claiming a frame longer than any frame can be", () => {
    const reader = new SerialReader();
    const bogus = bytes(0x4e, 0x42, 0, 0xff, 0xff, 0xff, 0xff);
    expect(reader.push(new Uint8Array([...bogus, ...encodeSerial(message("ok"))]))).toEqual([
      message("ok"),
    ]);
  });
});

describe("the agent's Hyper-V socket", () => {
  it("is the service id hv_sock gives its vsock port", () => {
    expect(hypervServiceId(HYPERV_AGENT_PORT)).toBe("00004e42-facb-11e6-bd58-64006a7986d3");
  });
});
