import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";
import { Tunnel } from "./tunnel.ts";

const command = ["tunnel", "--no-autoupdate", "--url", "http://server:8420"];
const deferred = <T>() => Promise.withResolvers<T>();

function setup(running = true) {
  let exists = running;
  const info = {
    Id: "container",
    Config: { Cmd: command },
    State: { Running: running, StartedAt: "2026-10-18T17:00:00.123456789Z" },
  };
  const container = {
    inspect: vi.fn(async () => {
      if (!exists) throw { statusCode: 404 };
      return structuredClone(info);
    }),
    start: vi.fn(async () => {
      info.State.Running = true;
    }),
    remove: vi.fn(async () => {
      exists = false;
    }),
    logs: vi.fn(async (_options: unknown): Promise<Buffer> => Buffer.from("")),
  };
  const docker = {
    getContainer: vi.fn(() => container),
    listImages: vi.fn(async () => [{}]),
    pull: vi.fn(async () => ({})),
    modem: { followProgress: vi.fn((_stream, done) => done(null)) },
    createContainer: vi.fn(async (options) => {
      exists = true;
      info.Config.Cmd = options.Cmd;
      return container;
    }),
  };
  const store = {
    setSetting: vi.fn(async (_key: string, _value: unknown) => {}),
    getSetting: vi.fn(async () => ({ mode: "quick" })),
  };
  const tunnel = new Tunnel(
    { docker } as unknown as Orchestrator,
    store as unknown as Store,
    {
      NIBBLET_INTERNAL_URL: "http://server:8420",
      NIBBLET_PUBLIC_URL: "http://local",
      NIBBLET_NETWORK: "network",
    } as Config,
  );
  return { tunnel, container, docker, store, info };
}

describe("Tunnel recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps looking for a late quick URL and preserves a matching running container", async () => {
    const { tunnel, container, docker } = setup();
    await tunnel.configure({ mode: "quick" });
    await vi.advanceTimersByTimeAsync(65_000);
    container.logs.mockResolvedValue(Buffer.from("https://late.trycloudflare.com"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(tunnel.current()).toMatchObject({ state: "up", url: "https://late.trycloudflare.com" });
    expect(container.remove).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it("health-checks an up tunnel every 15 s, not every second", async () => {
    const { tunnel, container } = setup();
    await tunnel.configure({ mode: "token", token: "test", hostname: "example.com" });
    expect(tunnel.current().state).toBe("up");
    const configured = container.inspect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(container.inspect).toHaveBeenCalledTimes(configured);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(container.inspect).toHaveBeenCalledTimes(configured + 1);
  });

  it("keeps reconciling when saving the tunnel settings fails", async () => {
    const { tunnel, container, store } = setup();
    const failure = new Error("disk full");
    store.setSetting.mockRejectedValueOnce(failure);
    await expect(
      tunnel.configure({ mode: "token", token: "test", hostname: "example.com" }),
    ).rejects.toBe(failure);
    expect(tunnel.current().state).toBe("up");
    const configured = container.inspect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(container.inspect.mock.calls.length).toBeGreaterThan(configured);
  });

  it("retries an errored tunnel after 5 s, not 1 s", async () => {
    const { tunnel, container } = setup();
    container.inspect.mockRejectedValueOnce(new Error("offline"));
    await tunnel.configure({ mode: "quick" });
    expect(tunnel.current().state).toBe("error");
    expect(container.inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(container.inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(container.inspect).toHaveBeenCalledTimes(2);
  });

  it("keeps polling every second while a quick URL has not appeared", async () => {
    const { tunnel, container } = setup();
    await tunnel.configure({ mode: "quick" });
    expect(tunnel.current().state).toBe("starting");
    expect(container.inspect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(container.inspect).toHaveBeenCalledTimes(2);
  });

  it.each(["inspect", "pull", "start"] as const)(
    "recovers after a transient %s failure",
    async (operation) => {
      const { tunnel, container, docker } = setup(operation === "inspect");
      if (operation === "pull") docker.listImages.mockResolvedValue([]);
      ({ inspect: container.inspect, pull: docker.pull, start: container.start })[
        operation
      ].mockRejectedValueOnce(new Error("temporarily unavailable"));
      await tunnel.configure({ mode: "quick" });
      expect(tunnel.current().state).toBe("error");
      if (operation === "inspect") {
        expect(container.remove).not.toHaveBeenCalled();
      }
      container.logs.mockResolvedValue(Buffer.from("https://recovered.trycloudflare.com"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(tunnel.current()).toMatchObject({
        state: "up",
        url: "https://recovered.trycloudflare.com",
      });
    },
  );

  it("scopes logs to the current start and follows the latest URL after a restart", async () => {
    const { tunnel, container, info } = setup();
    container.logs.mockResolvedValue(
      Buffer.from("https://first.trycloudflare.com\nhttps://last.trycloudflare.com"),
    );
    await tunnel.configure({ mode: "quick" });
    expect(tunnel.current().url).toBe("https://last.trycloudflare.com");
    expect(container.logs).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: info.State.StartedAt }),
    );
    container.logs.mockResolvedValue(Buffer.from("normal operation after startup log rollover"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tunnel.current().url).toBe("https://last.trycloudflare.com");
    info.State.StartedAt = "2026-10-18T17:01:00.987654321Z";
    container.logs.mockResolvedValue(Buffer.from(""));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tunnel.current()).toMatchObject({ state: "starting", url: null });
    container.logs.mockResolvedValue(Buffer.from("https://restart.trycloudflare.com"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(tunnel.current().url).toBe("https://restart.trycloudflare.com");
    info.Id = "replacement";
    container.logs.mockResolvedValue(Buffer.from(""));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tunnel.current()).toMatchObject({ state: "starting", url: null });
  });

  it.each(["off", "token", "stop"] as const)(
    "invalidates pending logs immediately on %s",
    async (action) => {
      const { tunnel, container } = setup();
      const pending = deferred<Buffer>();
      container.logs.mockReturnValueOnce(pending.promise);
      const initial = tunnel.configure({ mode: "quick" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(container.logs).toHaveBeenCalledTimes(1);
      expect(container.inspect).toHaveBeenCalledTimes(1);
      const next =
        action === "stop"
          ? (tunnel.stop(), Promise.resolve())
          : tunnel.configure(
              action === "off"
                ? { mode: "off" }
                : { mode: "token", token: "test", hostname: "example.com" },
            );
      pending.resolve(Buffer.from("https://obsolete.trycloudflare.com"));
      await initial;
      await next;
      expect(tunnel.current().url).not.toBe("https://obsolete.trycloudflare.com");
      if (action !== "stop") expect(tunnel.current().mode).toBe(action);
      const calls = container.logs.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(container.logs).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(["off", "token", "stop"] as const)(
    "does not start obsolete setup after %s",
    async (action) => {
      const { tunnel, docker, container } = setup(false);
      const pending = deferred<never[]>();
      docker.listImages.mockReturnValueOnce(pending.promise);
      const initial = tunnel.configure({ mode: "quick" });
      await vi.advanceTimersByTimeAsync(0);
      const next =
        action === "stop"
          ? (tunnel.stop(), Promise.resolve())
          : tunnel.configure(
              action === "off"
                ? { mode: "off" }
                : { mode: "token", token: "test", hostname: "example.com" },
            );
      pending.resolve([]);
      await initial;
      await next;
      expect(
        docker.createContainer.mock.calls.every(([options]) => options.Cmd.includes("run")),
      ).toBe(true);
      expect(container.start).toHaveBeenCalledTimes(action === "token" ? 1 : 0);
    },
  );

  it("serializes config persistence while superseding a pending write", async () => {
    const { tunnel, store, docker } = setup(false);
    const pending = deferred<void>();
    store.setSetting.mockReturnValueOnce(pending.promise);
    const initial = tunnel.configure({ mode: "quick" });
    await vi.advanceTimersByTimeAsync(0);
    const off = tunnel.configure({ mode: "off" });
    expect(store.setSetting).toHaveBeenCalledTimes(1);
    pending.resolve();
    await initial;
    await off;
    expect(store.setSetting).toHaveBeenLastCalledWith("tunnel", { mode: "off" });
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});
