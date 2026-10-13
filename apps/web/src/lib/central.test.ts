import { describe, expect, it } from "vitest";
import { chooseRoute } from "./central.ts";

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
});
