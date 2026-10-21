import { Duplex } from "node:stream";
import { encodeSerial, GuestToServer, SerialReader } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { GuestDaemon } from "../src/machine/daemon.ts";
import type { GuestPlugin } from "../src/machine/guest.ts";

const guest: GuestPlugin = {
  os: "linux",
  prepare: async () => {},
  openPort: () => Promise.reject(new Error("not in this test")),
  entry: () => ({ file: process.execPath, argv: [] }),
  poweroff: async () => {},
};

/** A port to the daemon: `ask` is the host talking, `epochs` what its hellos said. */
function port() {
  const reader = new SerialReader();
  const hellos: { link?: string; epoch?: string }[] = [];
  const end = new Duplex({
    read() {},
    write(chunk: Uint8Array, _enc, done) {
      for (const frame of reader.push(chunk)) {
        if (frame.kind !== "message") continue;
        const msg = GuestToServer.parse(JSON.parse(frame.text));
        if (msg.type === "hello") hellos.push({ link: msg.link, epoch: msg.epoch });
      }
      done();
    },
  });
  const ask = (msg: object) =>
    end.push(encodeSerial({ kind: "message", text: JSON.stringify(msg) }));
  return { end, ask, hellos };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("the guest agent's hello", () => {
  it("lets go of nothing when the same link asks again, and of its channels for a new one", async () => {
    const daemon = new GuestDaemon({
      guest,
      version: "test",
      listen: {
        server: { host: "127.0.0.1", port: 0 },
        credproxy: { host: "127.0.0.1", port: 0 },
      },
      log: () => {},
    });
    const p = port();
    daemon.attach(p.end);
    p.ask({ type: "hello", link: "a" });
    p.ask({ type: "hello", link: "a" });
    p.ask({ type: "hello", link: "b" });
    await settle();
    daemon.close();

    // Its own, on starting; then one answer to each asking.
    const [own, first, again, other] = p.hellos;
    expect(own?.link).toBeUndefined();
    expect(first).toMatchObject({ link: "a" });
    expect(again).toEqual(first);
    expect(other?.link).toBe("b");
    expect(other?.epoch).not.toBe(first?.epoch);
  });
});
