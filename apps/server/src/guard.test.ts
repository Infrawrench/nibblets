import { Hono } from "hono";
import type { TailnetNode } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { mountGuard, type GuardDeps } from "./guard.ts";
import { guardToken } from "./store.ts";

const OWNER = "owner-token";

function setup(login: { authKey: string; hostname: string; ports: number[] } | null) {
  const reports: TailnetNode[] = [];
  const deps = {
    config: { NIBBLET_OWNER_TOKEN: OWNER },
    store: {
      nibbletRow: async (id: string) => {
        if (id !== "nib_1") throw new Error("not found");
        return { tokenHash: "hash" };
      },
    },
    conductor: {
      guardConfig: async () => ({
        browser: false,
        toolApprovals: [],
        mcpServers: [],
        onePassword: null,
      }),
      tailscaleLogin: async () => login,
      setTailnetNode: async (_id: string, node: TailnetNode) => {
        reports.push(node);
      },
      activeTurnId: () => null,
      approvals: { request: async () => ({ approved: true, reason: null }) },
    },
  } as unknown as GuardDeps;
  const app = new Hono();
  mountGuard(app, deps);
  const auth = { authorization: `Bearer ${guardToken(OWNER, "nib_1", "hash")}` };
  return { app, auth, reports };
}

const running: TailnetNode = {
  state: "running",
  dnsName: "pip.tail1234.ts.net",
  ips: ["100.64.0.7"],
  tailnet: "example.com",
  detail: null,
};

describe("the container's Tailscale, at /guard/:id/tailscale", () => {
  it("gets the auth key only with the guard's token", async () => {
    const { app, auth } = setup({ authKey: "tskey-auth-x", hostname: "pip", ports: [3000] });
    expect((await app.request("/guard/nib_1/tailscale")).status).toBe(401);
    expect(
      (await app.request("/guard/nib_1/tailscale", { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    const res = await app.request("/guard/nib_1/tailscale", { headers: auth });
    expect(await res.json()).toEqual({ authKey: "tskey-auth-x", hostname: "pip", ports: [3000] });
  });

  it("finds nothing for a nibblet that isn't to join", async () => {
    const { app, auth } = setup(null);
    expect((await app.request("/guard/nib_1/tailscale", { headers: auth })).status).toBe(404);
  });

  it("takes reports of how its machine is doing", async () => {
    const { app, auth, reports } = setup(null);
    const post = (body: unknown, headers: Record<string, string> = auth) =>
      app.request("/guard/nib_1/tailscale", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(running, {})).status).toBe(401);
    expect((await post({ state: "sideways" })).status).toBe(400);
    expect((await post(running)).status).toBe(200);
    expect(reports).toEqual([running]);
  });
});
