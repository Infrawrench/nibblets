import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { LiveMessage } from "@nibblet/protocol";
import { Borrow, type BorrowDeps } from "./borrow.ts";
import type { MachinePlugin } from "@nibblet/machine";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";

/** A Borrow wired to fakes, with a handle on what it did. */
function make(opts: { onWindow?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const published: LiveMessage[] = [];
  let resolveWindow: () => void = () => {};
  const windowClosed = new Promise<void>((r) => (resolveWindow = r));

  const docker = {
    browserUserAgent: async () => {
      calls.push("ua");
      return "UA/1.0";
    },
    startBorrowProxy: async () => {
      calls.push("proxy-start");
      return { port: 54321, stop: async () => void calls.push("proxy-stop") };
    },
  } as unknown as Orchestrator;

  const machine = {
    name: "Docker",
    capabilities: () => ({ localSignIn: true }),
    archiveProfile: async (_id: string, out: NodeJS.WritableStream) => {
      calls.push("archive");
      // Like the real inHome: write the profile but leave ending the stream to the caller.
      out.write("profile-bytes");
    },
    restoreProfile: async (_id: string, archive: Readable) => {
      calls.push("restore");
      for await (const _ of archive) void _;
    },
  } as unknown as MachinePlugin;

  const store = {
    getNibblet: async (id: string) => ({
      id,
      parentId: null,
      browser: true,
      machine: { backend: "docker", guest: "linux" },
    }),
  } as unknown as Store;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/browser")) return Response.json({ chrome: true, onePassword: true });
    calls.push("borrow-request");
    // Drain the uploaded profile fully; this hangs if the body is never ended.
    const reader = (init?.body as ReadableStream<Uint8Array> | undefined)?.getReader();
    while (reader) {
      const { done } = await reader.read();
      if (done) break;
    }
    // The window stays open until the test closes it, then hands a profile back.
    await (opts.onWindow?.() ?? windowClosed);
    return new Response(Readable.toWeb(Readable.from(["handed-back"])) as ReadableStream, {
      status: 200,
    });
  };

  const deps: BorrowDeps = {
    docker,
    machines: { get: () => machine },
    store,
    config: { HOST_MCP_URL: "http://bridge", HOST_MCP_TOKEN: "t" } as Config,
    stop: async () => void calls.push("stop"),
    start: async () => void calls.push("start"),
    publish: (m) => void published.push(m),
    fetch: fetchImpl,
  };
  return { borrow: new Borrow(deps), calls, published, closeWindow: resolveWindow };
}

const states = (published: LiveMessage[]) =>
  published.flatMap((m) => (m.type === "browser_borrow" ? [m.borrow.state] : []));

describe("Borrow", () => {
  it("stops the nibblet, proxies, and opens the window before returning", async () => {
    const { borrow, calls } = make();
    const result = await borrow.start("n1");
    expect(result.state).toBe("local");
    expect(result.proxyPort).toBe(54321);
    // Stop comes before the proxy and the window; the UA is read while it's still up.
    expect(calls).toContain("stop");
    expect(calls.indexOf("ua")).toBeLessThan(calls.indexOf("stop"));
    expect(calls.indexOf("stop")).toBeLessThan(calls.indexOf("proxy-start"));
    expect(borrow.borrowed("n1")).toBe(true);
  });

  it("hands back and restarts when the window closes", async () => {
    const { borrow, calls, published, closeWindow } = make();
    await borrow.start("n1");
    closeWindow();
    // Let the background run() settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("restore");
    expect(calls.indexOf("restore")).toBeLessThan(calls.indexOf("proxy-stop"));
    expect(calls.indexOf("proxy-stop")).toBeLessThan(calls.indexOf("start"));
    expect(borrow.borrowed("n1")).toBe(false);
    expect(states(published)).toEqual(["preparing", "local", "handback"]);
    expect(published.at(-1)).toEqual({ type: "browser_borrow_ended", nibbletId: "n1" });
  });

  it("refuses a sub-agent", async () => {
    const { borrow } = make();
    (borrow as unknown as { deps: BorrowDeps }).deps.store.getNibblet = (async (id: string) => ({
      id,
      parentId: "parent",
      browser: true,
    })) as Store["getNibblet"];
    await expect(borrow.start("child")).rejects.toThrow(/sub-agent/i);
  });

  it("without a host bridge, says so and never stops the nibblet", async () => {
    const { borrow, calls } = make();
    (borrow as unknown as { deps: BorrowDeps }).deps.config = { HOST_MCP_URL: "" } as Config;
    await expect(borrow.start("n1")).rejects.toThrow(/desktop app/i);
    expect(calls).not.toContain("stop");
  });
});
