import { Duplex, PassThrough } from "node:stream";
import { SerialReader } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import type { GuestSocket } from "../src/guest-link.ts";
import { GuestRelay } from "../src/host/index.ts";

/** A server's end that does nothing. */
const server = (): GuestSocket => ({
  send() {},
  close() {},
  bufferedAmount: 0,
  onMessage() {},
  onClose() {},
});

/** A guest's port that keeps what the relay says to it, and says nothing back. */
function guestPort(): Duplex & { said(): string[] } {
  const written: Uint8Array[] = [];
  const port = new Duplex({
    read() {},
    write(chunk: Uint8Array, _enc, done) {
      written.push(chunk);
      done();
    },
  });
  return Object.assign(port, {
    said() {
      const reader = new SerialReader();
      const messages = written.splice(0).flatMap((chunk) => reader.push(chunk));
      return messages.flatMap((m) => (m.kind === "message" ? [m.text.replace(/\s/g, "")] : []));
    },
  });
}

const targets = {
  server: { host: "127.0.0.1", port: 1 },
  credproxy: { host: "127.0.0.1", port: 2 },
};

describe("a VM's relay", () => {
  it("takes a port while it's open", () => {
    const relay = new GuestRelay(targets, () => {});
    const port = new PassThrough();
    relay.attachPort(port);
    expect(relay.connected).toBe(true);
    expect(port.destroyed).toBe(false);
  });

  // To the guest, a connection made late, for a relay that's gone, would be the host's newest.
  it("lets go of a port that comes once it's closed", () => {
    const relay = new GuestRelay(targets, () => {});
    relay.close();
    const port = new PassThrough();
    relay.attachPort(port);
    expect(relay.connected).toBe(false);
    expect(port.destroyed).toBe(true);
  });

  // The link says hello as it opens: a second, from here, would be answered
  // twice, and the second answer would cut off what the link had started.
  it("says nothing to the guest when a server comes, and asks it again when its port does", () => {
    const relay = new GuestRelay(targets, () => {});
    const port = guestPort();
    relay.attachPort(port);
    expect(port.said()).toEqual(['{"type":"reset"}']);
    relay.attachServer(server());
    expect(port.said()).toEqual([]);
    const again = guestPort();
    relay.attachPort(again);
    expect(again.said()).toEqual(['{"type":"reset"}', '{"type":"hello"}']);
  });
});
