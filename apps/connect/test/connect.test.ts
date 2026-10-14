import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { CentralServer, LinkPollResponse, LinkStartResponse, ServerToken } from "@nibblet/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Connect } from "../../server/src/connect.ts";
import { createApp, sweepLinks, type ConnectEnv } from "../src/app.ts";

/*
 * The whole Nibblets Connect flow against a real D1 database (Miniflare),
 * with the server's own `Connect` doing its side: link, approve, heartbeat,
 * mint a token, and the server accepting it.
 */

const LOCAL = "http://localhost:8787";
let mf: Miniflare;
let env: ConnectEnv;
const app = createApp();

async function privateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return JSON.stringify({
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid: "test-key",
  });
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null) } }",
    d1Databases: { DB: "nibblets-connect-test" },
  });
  const db = await mf.getD1Database("DB");
  const schema = readFileSync(
    fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)),
    "utf8",
  );
  const statements = schema
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
  env = {
    DB: db,
    PUBLIC_URL: "",
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "pk_test_x",
    JWT_PRIVATE_KEY: await privateKey(),
    DEV_AUTH_USER: "astrid",
    CF_API_TOKEN: "",
    CF_ACCOUNT_ID: "",
    CF_ZONE_ID: "",
    CF_ZONE_NAME: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_SUBJECT: "",
  };
});

afterAll(() => mf.dispose());

/** The Worker app as a fetch function, the way a server or browser reaches it. */
const centralFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  return app.fetch(request, env);
};

const call = (path: string, init: RequestInit = {}, base = LOCAL) =>
  centralFetch(`${base}${path}`, init);

describe("dev sign-in", () => {
  it("only works on localhost", async () => {
    expect((await call("/v1/servers")).status).toBe(200);
    expect((await call("/v1/servers", {}, "https://nibblets.example.com")).status).toBe(401);
  });
});

describe("linking a server", () => {
  it("goes start → approve → poll, then heartbeats, mints tokens, and unlinks", async () => {
    const started = LinkStartResponse.parse(
      await (
        await call("/v1/link/start", {
          method: "POST",
          body: JSON.stringify({ name: "PogAir", hostname: "pogair.local", platform: "darwin" }),
        })
      ).json(),
    );
    expect(started.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.approveUrl).toBe(`${LOCAL}/link?code=${started.code}`);

    const poll = async () =>
      LinkPollResponse.parse(
        await (
          await call("/v1/link/poll", {
            method: "POST",
            headers: { authorization: `Bearer ${started.pollToken}` },
          })
        ).json(),
      );
    expect(await poll()).toEqual({ status: "pending" });

    const pending = await (await call(`/v1/link/${started.code}`)).json();
    expect(pending).toMatchObject({ name: "PogAir", platform: "darwin" });
    expect((await call(`/v1/link/${started.code}/approve`, { method: "POST" })).status).toBe(200);

    const approved = await poll();
    if (approved.status !== "approved")
      throw new Error(`expected approved, got ${approved.status}`);
    expect(approved.tunnel).toBeNull(); // No zone configured: the server runs a quick tunnel.
    // Credentials are handed over once.
    expect(await poll()).toEqual({ status: "expired" });

    const beat = await call(`/v1/servers/${approved.serverId}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${approved.serverSecret}` },
      body: JSON.stringify({
        name: "PogAir",
        version: "0.1.0",
        nibblets: 3,
        routes: { lan: [], tailscale: null, tunnel: "https://a-b.trycloudflare.com" },
      }),
    });
    expect(await beat.json()).toMatchObject({ linked: true, centralUrl: expect.any(String) });
    const wrongSecret = await call(`/v1/servers/${approved.serverId}/heartbeat`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "{}",
    });
    expect(wrongSecret.status).toBe(401);

    const listed = z
      .object({ servers: z.array(CentralServer) })
      .parse(await (await call("/v1/servers")).json());
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0]).toMatchObject({
      id: approved.serverId,
      online: true,
      nibblets: 3,
      routes: { tunnel: "https://a-b.trycloudflare.com" },
    });

    const minted = ServerToken.parse(
      await (await call(`/v1/servers/${approved.serverId}/token`, { method: "POST" })).json(),
    );
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    expect((await call(`/v1/servers/${approved.serverId}`, { method: "DELETE" })).status).toBe(200);
    const afterRemove = await call(`/v1/servers/${approved.serverId}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${approved.serverSecret}` },
      body: "{}",
    });
    expect(afterRemove.status).toBe(401);
  });

  it("lets the person deny a code", async () => {
    const started = LinkStartResponse.parse(
      await (
        await call("/v1/link/start", {
          method: "POST",
          body: JSON.stringify({ name: "Stranger", hostname: "x", platform: "linux" }),
        })
      ).json(),
    );
    await call(`/v1/link/${started.code}/deny`, { method: "POST" });
    const answer = await call("/v1/link/poll", {
      method: "POST",
      headers: { authorization: `Bearer ${started.pollToken}` },
    });
    expect(await answer.json()).toEqual({ status: "denied" });
  });
});

describe("a server's Connect against the central service", () => {
  it("links, beats, and accepts a token the central service minted, and nothing else", async () => {
    const settings = new Map<string, unknown>();
    const tunnel = { mode: "off" };
    const realFetch = globalThis.fetch;
    // jose fetches the JWKS with the global fetch; route it to the Worker app.
    globalThis.fetch = (input, init) =>
      new Request(input, init).url.startsWith(LOCAL)
        ? centralFetch(input, init)
        : realFetch(input, init);
    try {
      const connect = serverConnect(settings, tunnel);

      const linking = await connect.start();
      if (linking.state !== "linking") throw new Error("expected linking");
      await call(`/v1/link/${linking.code}/approve`, { method: "POST" });
      // Polling and the first heartbeat run on timers; wait for them.
      for (let i = 0; i < 50 && connect.status().state !== "linked"; i++) await sleep(100);
      const linked = connect.status();
      if (linked.state !== "linked") throw new Error(`expected linked, got ${linked.state}`);
      expect(tunnel.mode).toBe("quick");
      for (let i = 0; i < 50; i++) {
        const s = connect.status();
        if (s.state === "linked" && s.lastHeartbeatAt) break;
        await sleep(100);
      }

      const servers = z
        .object({ servers: z.array(CentralServer) })
        .parse(await (await call("/v1/servers")).json());
      const mine = servers.servers.find((s) => s.id === linked.serverId);
      expect(mine).toMatchObject({
        name: "Astrid's Mac",
        online: true,
        routes: { tunnel: "https://q.trycloudflare.com" },
      });

      const { token } = ServerToken.parse(
        await (await call(`/v1/servers/${linked.serverId}/token`, { method: "POST" })).json(),
      );
      expect(await connect.verify(token)).toEqual({ sub: "astrid", name: "astrid (dev)" });

      // Tampering, or a token for another server, is refused.
      const [h, p, sig] = token.split(".");
      expect(
        await connect.verify(
          `${h}.${p}.${(sig ?? "").replace(/^./, (c) => (c === "A" ? "B" : "A"))}`,
        ),
      ).toBeNull();
      expect(await connect.verify("not-a-jwt")).toBeNull();

      await connect.unlink();
      expect(connect.status().state).toBe("unlinked");
      expect(settings.has("connect")).toBe(false);
      expect(tunnel.mode).toBe("off");
      connect.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("collects an approval that lands while it's restarting", async () => {
    const settings = new Map<string, unknown>();
    const before = serverConnect(settings, { mode: "off" });
    const linking = await before.start();
    if (linking.state !== "linking") throw new Error("expected linking");
    // Asking again while the code is live keeps the same code.
    expect(await before.start()).toMatchObject({ code: linking.code });
    before.stop();

    await call(`/v1/link/${linking.code}/approve`, { method: "POST" });
    const after = serverConnect(settings, { mode: "off" });
    await after.restore();
    for (let i = 0; i < 50 && after.status().state !== "linked"; i++) await sleep(100);
    expect(after.status().state).toBe("linked");
    expect(settings.has("connect.pending")).toBe(false);
    await after.unlink();
    after.stop();
  });
});

describe("sweeping links that went nowhere", () => {
  it("removes servers whose approval was never collected", async () => {
    const started = LinkStartResponse.parse(
      await (
        await call("/v1/link/start", {
          method: "POST",
          body: JSON.stringify({ name: "Ghost", hostname: "ghost.local", platform: "darwin" }),
        })
      ).json(),
    );
    await call(`/v1/link/${started.code}/approve`, { method: "POST" });
    const names = async () =>
      z
        .object({ servers: z.array(CentralServer) })
        .parse(await (await call("/v1/servers")).json())
        .servers.map((s) => s.name);
    expect(await names()).toContain("Ghost");

    // Not yet: the server might still be on its way.
    expect(await sweepLinks(env)).toBe(0);
    expect(await sweepLinks(env, Date.now() + 60 * 60_000)).toBe(1);
    expect(await names()).not.toContain("Ghost");
  });
});

/** The server's own Connect, with an in-memory settings table, talking to the Worker app. */
function serverConnect(settings: Map<string, unknown>, tunnel: { mode: string }): Connect {
  return new Connect({
    store: {
      getSetting: async <T>(key: string, parse: (v: unknown) => T, fallback: T) =>
        settings.has(key) ? parse(settings.get(key)) : fallback,
      setSetting: async (key: string, value: unknown) => {
        // Like the real table: a setting is a value, never null.
        if (value === null || value === undefined) throw new Error("settings can't be null");
        settings.set(key, value);
      },
      deleteSetting: async (key: string) => {
        settings.delete(key);
      },
    },
    tunnel: {
      configure: async (config) => {
        tunnel.mode = config.mode;
        return { mode: config.mode, state: "up", url: "https://q.trycloudflare.com", detail: null };
      },
      current: () => ({
        mode: "quick",
        state: "up",
        url: "https://q.trycloudflare.com",
        detail: null,
      }),
    },
    config: {
      NIBBLET_CENTRAL_URL: LOCAL,
      NIBBLET_HOST_NAME: "pogair",
      NIBBLET_HOST_PLATFORM: "darwin",
      NIBBLET_LAN_URLS: [],
    },
    version: "0.1.0",
    serverName: async () => "Astrid's Mac",
    nibbletCount: async () => 1,
    tailscaleUrl: async () => null,
    fetch: centralFetch,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
