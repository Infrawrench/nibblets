import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { GuestRelay } from "../src/host/index.ts";

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
});
