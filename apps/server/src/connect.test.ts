import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_EVERY_MS, type TunnelStatus } from "@nibblet/protocol";
import { Connect, type ConnectDeps } from "./connect.ts";

const saved = {
  centralUrl: "https://old.example",
  serverId: "server-1",
  serverSecret: "secret",
  account: "person",
  tunnel: null,
  linkedAt: "2026-10-18T12:00:00.000Z",
};
const tunnelStatus: TunnelStatus = {
  mode: "quick",
  state: "up",
  url: "https://tunnel.example",
  detail: null,
};
const response = (centralUrl = saved.centralUrl): Response =>
  Response.json({ linked: true, centralUrl });

describe("Connect heartbeats", () => {
  let connect: Connect;
  let settings: Map<string, unknown>;
  let deps: ConnectDeps;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let configure: ReturnType<typeof vi.fn<ConnectDeps["tunnel"]["configure"]>>;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = new Map([["connect", { ...saved }]]);
    fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    configure = vi.fn<ConnectDeps["tunnel"]["configure"]>().mockResolvedValue(tunnelStatus);
    deps = {
      store: {
        async getSetting(key, parse, fallback) {
          return settings.has(key) ? parse(settings.get(key)) : fallback;
        },
        setSetting: vi.fn(async (key, value) => {
          settings.set(key, structuredClone(value));
        }),
        deleteSetting: vi.fn(async (key) => {
          settings.delete(key);
        }),
      },
      tunnel: { configure, current: () => tunnelStatus },
      config: {
        NIBBLET_CENTRAL_URL: saved.centralUrl,
        NIBBLET_HOST_NAME: "host",
        NIBBLET_HOST_PLATFORM: "linux",
        NIBBLET_LAN_URLS: ["http://localhost:8420"],
      },
      version: "test",
      serverName: async () => "Test server",
      nibbletCount: async () => 2,
      tailscaleUrl: async () => null,
      fetch: fetcher,
    };
    connect = new Connect(deps);
  });

  afterEach(() => {
    connect.stop();
    vi.useRealTimers();
  });

  it.each([saved.centralUrl, "https://new.example/"])(
    "keeps beating after canonical URL %s and persists the new origin",
    async (canonical) => {
      fetcher.mockResolvedValueOnce(response(canonical));
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      expect(connect.status()).toMatchObject({
        centralUrl: canonical.replace(/\/+$/, ""),
        lastError: null,
        lastHeartbeatAt: expect.any(String),
      });
      expect(settings.get("connect")).toMatchObject({ centralUrl: canonical.replace(/\/+$/, "") });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "https://old.example/v1/servers/server-1/heartbeat",
        `${canonical.replace(/\/+$/, "")}/v1/servers/server-1/heartbeat`,
      ]);
    },
  );

  it("does not resurrect the saved link when a canonical write commits during unlink", async () => {
    const commit = Promise.withResolvers<void>();
    vi.mocked(deps.store.setSetting).mockImplementationOnce(async (key, value) => {
      const snapshot = structuredClone(value);
      await commit.promise;
      settings.set(key, snapshot);
    });
    fetcher.mockResolvedValueOnce(response("https://new.example"));
    await connect.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.store.setSetting).toHaveBeenCalledTimes(1);
    const unlinking = connect.unlink();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect.status().state).toBe("unlinked");
    commit.resolve();
    await unlinking;
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.has("connect")).toBe(false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries persisting a canonical URL after a failed setting write", async () => {
    vi.mocked(deps.store.setSetting).mockRejectedValueOnce(new Error("database unavailable"));
    fetcher.mockImplementation(async () => response("https://new.example"));
    await connect.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.get("connect")).toMatchObject({ centralUrl: saved.centralUrl });
    expect(connect.status()).toMatchObject({ lastError: "database unavailable" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(settings.get("connect")).toMatchObject({ centralUrl: "https://new.example" });
    expect(connect.status()).toMatchObject({ centralUrl: "https://new.example", lastError: null });
  });

  it("retries a transient fetch failure on the next heartbeat", async () => {
    fetcher.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await connect.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect.status()).toMatchObject({ lastError: "temporarily unavailable" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(connect.status()).toMatchObject({
      lastError: null,
      lastHeartbeatAt: expect.any(String),
    });
  });

  it.each(["stop", "unlink"] as const)(
    "%s invalidates an in-flight heartbeat before it can write or rearm",
    async (action) => {
      const pending = Promise.withResolvers<Response>();
      fetcher.mockReturnValueOnce(pending.promise);
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      const unlinkResponse = Promise.withResolvers<Response>();
      fetcher.mockReturnValueOnce(unlinkResponse.promise);
      const unlinking = action === "unlink" ? connect.unlink() : undefined;
      if (action === "stop") connect.stop();
      const status = structuredClone(connect.status());
      pending.resolve(response("https://stale.example"));
      await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS * 2);
      expect(connect.status()).toEqual(status);
      expect(deps.store.setSetting).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
      unlinkResponse.resolve(new Response(null, { status: 204 }));
      await unlinking;
      if (action === "unlink") {
        expect(connect.status().state).toBe("unlinked");
        expect(settings.has("connect")).toBe(false);
      }
    },
  );

  it.each([401, 404, "unlinked"] as const)(
    "forgets the active link when central answers %s",
    async (result) => {
      fetcher.mockResolvedValueOnce(
        result === "unlinked"
          ? Response.json({ linked: false })
          : new Response(null, { status: result }),
      );
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      expect(connect.status().state).toBe("unlinked");
      expect(settings.has("connect")).toBe(false);
      expect(configure).toHaveBeenLastCalledWith({ mode: "off" });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 404, "unlinked", "error"] as const)(
    "ignores stale %s after a new activation",
    async (result) => {
      const pending = Promise.withResolvers<Response>();
      fetcher.mockReturnValueOnce(pending.promise);
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      connect.stop();
      settings.set("connect", { ...saved, serverId: "server-2" });
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      const status = structuredClone(connect.status());
      if (result === "error") pending.reject(new Error("old failure"));
      else
        pending.resolve(
          result === "unlinked"
            ? Response.json({ linked: false })
            : new Response(null, { status: result }),
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(connect.status()).toEqual(status);
      expect(settings.get("connect")).toMatchObject({ serverId: "server-2" });
      expect(configure.mock.calls.some(([config]) => config.mode === "off")).toBe(false);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls[2]?.[0]).toBe("https://old.example/v1/servers/server-2/heartbeat");
    },
  );

  it.each(["routes", "name", "count", "body"] as const)(
    "stopping while awaiting %s prevents late work",
    async (boundary) => {
      const pending = Promise.withResolvers<null>();
      if (boundary === "routes") deps.tailscaleUrl = () => pending.promise;
      if (boundary === "name")
        deps.serverName = async () => {
          await pending.promise;
          return "Late";
        };
      if (boundary === "count")
        deps.nibbletCount = async () => {
          await pending.promise;
          return 3;
        };
      if (boundary === "body") {
        const res = response();
        vi.spyOn(res, "json").mockImplementation(async () => {
          await pending.promise;
          return { linked: false };
        });
        fetcher.mockResolvedValueOnce(res);
      }
      await connect.restore();
      await vi.advanceTimersByTimeAsync(0);
      connect.stop();
      const status = structuredClone(connect.status());
      pending.resolve(null);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
      expect(connect.status()).toEqual(status);
      expect(fetcher).toHaveBeenCalledTimes(boundary === "body" ? 1 : 0);
      expect(settings.has("connect")).toBe(true);
    },
  );

  it("sends its first heartbeat while tunnel setup is still pending", async () => {
    const pending = Promise.withResolvers<TunnelStatus>();
    configure.mockReturnValueOnce(pending.promise);
    const restoring = connect.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    connect.stop();
    pending.reject(new Error("late tunnel failure"));
    await restoring;
    expect(connect.status()).toMatchObject({ lastError: null });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
