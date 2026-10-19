import { afterEach, describe, expect, it, vi } from "vitest";
import { socketFeed, refetchOnLiveOpen, type LiveState } from "./connection.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

/** A WebSocket that opens as soon as it's made, like one to this computer. */
class InstantSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.onopen?.());
  }
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live feed state", () => {
  it("recovers an exhausted cold-start host query when the original socket opens later", async () => {
    vi.stubGlobal("WebSocket", InstantSocket);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    let reachable = false;
    const observer = new QueryObserver(client, {
      queryKey: ["info", "local"],
      queryFn: async () => {
        if (!reachable) throw new TypeError("Host offline");
        return { serverId: "verified-host" };
      },
    });
    const unsubscribeQuery = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(observer.getCurrentResult().isError).toBe(true);
    let openSocket!: (url: string) => void;
    const feed = socketFeed(
      () =>
        new Promise<string>((resolve) => {
          openSocket = resolve;
        }),
    );
    const stopRecovery = refetchOnLiveOpen(feed, () => {
      void observer.refetch();
    });
    const recovered = new Promise<void>((resolve) => {
      const stop = observer.subscribe((result) => {
        if (result.isSuccess) {
          stop();
          resolve();
        }
      });
    });
    reachable = true;
    openSocket("ws://127.0.0.1:8420/api/live");
    await recovered;
    expect(observer.getCurrentResult().data?.serverId).toBe("verified-host");
    stopRecovery();
    unsubscribeQuery();
    feed.close();
    client.clear();
  });
  it("tells a listener that arrives after the socket opened that it's open", async () => {
    vi.stubGlobal("WebSocket", InstantSocket);
    const feed = socketFeed(async () => "ws://127.0.0.1:8420/api/live");
    await new Promise((r) => setTimeout(r, 0));
    const seen: LiveState[] = [];
    feed.onState((s) => seen.push(s));
    expect(seen).toEqual(["open"]);
    feed.close();
  });
});

it("does not open a socket after closing while its ticket is pending", async () => {
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  let resolve!: (url: string) => void;
  const feed = socketFeed(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  feed.close();
  resolve("ws://remote.example/api/live");
  await Promise.resolve();
  expect(socket).not.toHaveBeenCalled();
});

it("cancels a pending reconnect timer on close", async () => {
  vi.useFakeTimers();
  const ticket = vi.fn(async () => {
    throw new Error("offline");
  });
  const feed = socketFeed(ticket);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  feed.close();
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(ticket).toHaveBeenCalledTimes(1);
});
