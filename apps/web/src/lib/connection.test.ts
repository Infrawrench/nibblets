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

afterEach(() => vi.unstubAllGlobals());

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
