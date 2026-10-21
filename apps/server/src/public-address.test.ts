import type { TunnelStatus } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { PublicAddresses } from "./public-address.ts";

function setUp() {
  const settings = new Map<string, unknown>();
  const tunnel: { status: TunnelStatus } = {
    status: { mode: "off", state: "off", url: null, detail: null },
  };
  const addresses = new PublicAddresses({
    store: {
      // As the store does, a value that doesn't parse reads as the fallback.
      async getSetting<T>(key: string, parse: (v: unknown) => T, fallback: T) {
        try {
          return settings.has(key) ? parse(settings.get(key)) : fallback;
        } catch {
          return fallback;
        }
      },
      async setSetting(key: string, value: unknown) {
        settings.set(key, value);
      },
      async deleteSetting(key: string) {
        settings.delete(key);
      },
    },
    tunnel: { current: () => tunnel.status },
  });
  return { addresses, settings, tunnel };
}

describe("PublicAddresses", () => {
  it("is nothing until there's a tunnel or a reverse proxy", async () => {
    const { addresses, tunnel } = setUp();
    expect(await addresses.current()).toEqual({ url: null, via: null, proxy: null });
    tunnel.status = { mode: "token", state: "starting", url: null, detail: null };
    expect((await addresses.current()).url).toBeNull();
  });

  it("is the tunnel's while it's up, saying when that's a quick one", async () => {
    const { addresses, tunnel } = setUp();
    tunnel.status = { mode: "token", state: "up", url: "https://pip.nibblets.dev/", detail: null };
    expect(await addresses.current()).toEqual({
      url: "https://pip.nibblets.dev",
      via: "tunnel",
      proxy: null,
    });
    tunnel.status = {
      mode: "quick",
      state: "up",
      url: "https://a-b.trycloudflare.com",
      detail: null,
    };
    expect((await addresses.current()).via).toBe("quick_tunnel");
  });

  it("is the reverse proxy's, over the tunnel's, until it's taken away", async () => {
    const { addresses, settings, tunnel } = setUp();
    tunnel.status = { mode: "token", state: "up", url: "https://pip.nibblets.dev", detail: null };
    expect(await addresses.setProxy("https://nibblets.example.com")).toEqual({
      url: "https://nibblets.example.com",
      via: "proxy",
      proxy: "https://nibblets.example.com",
    });
    expect(await addresses.setProxy(null)).toMatchObject({ via: "tunnel" });
    expect(settings.size).toBe(0);
  });

  it("ignores a saved address that's no longer a valid one", async () => {
    const { addresses, settings } = setUp();
    settings.set("publicProxy", "http://plain.example");
    expect((await addresses.current()).url).toBeNull();
  });
});
