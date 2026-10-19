import { afterEach, describe, expect, it, vi } from "vitest";
import { socketFeed, type LiveState } from "./connection.ts";

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
