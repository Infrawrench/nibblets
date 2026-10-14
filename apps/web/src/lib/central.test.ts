import { describe, expect, it } from "vitest";
import { chooseRoute, LOCAL_SERVER_URL, localServerId } from "./central.ts";

const routes = {
  lan: ["http://192.168.1.20:8420"],
  tailscale: "https://pogair.tail1234.ts.net",
  tunnel: "https://hamster.trycloudflare.com",
};

const answering =
  (...up: string[]) =>
  async (url: string) =>
    up.includes(url);

describe("chooseRoute", () => {
  it("prefers the local network, then the tailnet, then the tunnel", async () => {
    expect(await chooseRoute(routes, answering(...Object.values(routes).flat()))).toEqual({
      kind: "lan",
      url: "http://192.168.1.20:8420",
    });
    expect(await chooseRoute(routes, answering(routes.tailscale, routes.tunnel))).toMatchObject({
      kind: "tailscale",
    });
  });

  it("fails over to whatever still answers", async () => {
    expect(await chooseRoute(routes, answering(routes.tunnel))).toMatchObject({ kind: "tunnel" });
  });

  it("gives up when nothing answers", async () => {
    expect(await chooseRoute(routes, answering())).toBeNull();
    expect(await chooseRoute({ lan: [], tailscale: null, tunnel: null }, answering())).toBeNull();
  });

  it("reaches this computer's own server here first, and its routes after", async () => {
    const everything = answering(LOCAL_SERVER_URL, ...Object.values(routes).flat());
    expect(await chooseRoute(routes, everything, true)).toEqual({
      kind: "local",
      url: LOCAL_SERVER_URL,
    });
    expect(await chooseRoute(routes, answering(routes.tunnel), true)).toMatchObject({
      kind: "tunnel",
    });
    expect(await chooseRoute(routes, everything)).toMatchObject({ kind: "lan" });
  });
});

describe("localServerId", () => {
  it("reads the server the desktop app says is this computer's", () => {
    expect(localServerId("Mozilla/5.0 NibbletsDesktop/darwin NibbletsLocal/srv_ab12-C")).toBe(
      "srv_ab12-C",
    );
    expect(localServerId("Mozilla/5.0 NibbletsDesktop/darwin")).toBeNull();
  });
});
