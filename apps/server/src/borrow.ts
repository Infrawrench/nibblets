import { PassThrough, Readable } from "node:stream";
import {
  RpcError,
  type BrowserBorrow,
  type BrowserBorrowState,
  type LiveMessage,
} from "@nibblet/protocol";
import type { MachinePlugin, MachineRegistry } from "@nibblet/machine";
import type { Config } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";

/** One borrow in flight: its state and how to stop the window and the proxy. */
interface Active {
  state: BrowserBorrowState;
  controller: AbortController;
  proxyPort: number | null;
  stopProxy: (() => Promise<void>) | null;
  onePassword: boolean;
  detail: string | null;
  startedAt: number;
}

/** A machine plugin that can lend its browser's profile out. */
type Lender = MachinePlugin & Required<Pick<MachinePlugin, "archiveProfile" | "restoreProfile">>;

function lends(plugin: MachinePlugin): plugin is Lender {
  return plugin.archiveProfile !== undefined && plugin.restoreProfile !== undefined;
}

export interface BorrowDeps {
  store: Store;
  /** For the proxy and the runner image's user-agent. */
  docker: Orchestrator;
  /** Where each nibblet's machine (and so its profile) comes from. */
  machines: Pick<MachineRegistry, "get">;
  config: Config;
  /** Stops the nibblet (its Chromium and agent), so its profile can be copied out. */
  stop: (nibbletId: string) => Promise<unknown>;
  /** Starts the nibblet again once the profile has been handed back. */
  start: (nibbletId: string) => Promise<unknown>;
  publish: (message: LiveMessage) => void;
  /** Swapped in tests. */
  fetch?: typeof fetch;
}

/**
 * Borrowing a nibblet's browser profile onto the host for a quick sign-in.
 * It stops the nibblet, copies its profile to the machine running the host
 * bridge, opens it there in a Chrome window, and — when the window closes —
 * copies the profile (every extension purged) back and starts the nibblet.
 * A proxy on the nibblet's network, published on the host's loopback, lets
 * the window egress from the same place the nibblet would.
 */
export class Borrow {
  private readonly deps: BorrowDeps;
  private readonly fetch: typeof fetch;
  private readonly active = new Map<string, Active>();

  constructor(deps: BorrowDeps) {
    this.deps = deps;
    this.fetch = deps.fetch ?? fetch;
  }

  /** Whether a nibblet is being borrowed right now (so it mustn't be woken). */
  borrowed(nibbletId: string): boolean {
    return this.active.has(nibbletId);
  }

  /** The nibblet's current borrow, or null. */
  current(nibbletId: string): BrowserBorrow | null {
    const rec = this.active.get(nibbletId);
    return rec ? this.snapshot(nibbletId, rec) : null;
  }

  async start(nibbletId: string): Promise<BrowserBorrow> {
    const { config, store, docker } = this.deps;
    if (!config.HOST_MCP_URL)
      throw new RpcError(
        "unavailable",
        "Signing in locally needs the desktop app, which runs the browser on your computer.",
      );
    const existing = this.active.get(nibbletId);
    if (existing) return this.snapshot(nibbletId, existing);

    const nibblet = await store.getNibblet(nibbletId);
    if (nibblet.parentId)
      throw new RpcError("bad_request", "A sub-agent shares its parent's browser; borrow that.");
    if (!nibblet.browser) throw new RpcError("bad_request", "This nibblet has no browser.");
    const machine = this.deps.machines.get(nibblet.machine);
    if (!machine.capabilities(nibblet.machine.guest).localSignIn || !lends(machine))
      throw new RpcError(
        "bad_request",
        `Signing in locally only works for nibblets in containers for now, not in ${machine.name}.`,
      );

    const host = await this.hostBrowser();
    if (!host.chrome)
      throw new RpcError(
        "unavailable",
        "No Chrome, Chromium, Edge or Brave is installed on the computer running the server.",
      );

    const rec: Active = {
      state: "preparing",
      controller: new AbortController(),
      proxyPort: null,
      stopProxy: null,
      onePassword: host.onePassword,
      detail: null,
      startedAt: Date.now(),
    };
    this.active.set(nibbletId, rec);
    this.emit(nibbletId, rec);

    try {
      const userAgent = await docker.browserUserAgent();
      await this.deps.stop(nibbletId);
      const proxy = await docker.startBorrowProxy(nibbletId);
      rec.proxyPort = proxy.port;
      rec.stopProxy = proxy.stop;
      rec.state = "local";
      this.emit(nibbletId, rec);
      // Runs until the window closes; the RPC returns now, with the window open.
      void this.run(nibbletId, rec, userAgent, machine);
      return this.snapshot(nibbletId, rec);
    } catch (err) {
      await this.finish(nibbletId, rec);
      throw err instanceof RpcError
        ? err
        : new RpcError("unavailable", err instanceof Error ? err.message : String(err));
    }
  }

  /** Ends a borrow early, throwing away whatever was done in the window. */
  async end(nibbletId: string): Promise<BrowserBorrow> {
    const rec = this.active.get(nibbletId);
    if (!rec) throw new RpcError("bad_request", "It isn't signed in locally.");
    // Once it's handing back, the copy is already coming; let it finish.
    if (rec.state !== "handback") rec.controller.abort();
    return this.snapshot(nibbletId, rec);
  }

  /** Aborts every borrow, e.g. on shutdown, so no window is left holding a profile. */
  abortAll(): void {
    for (const rec of this.active.values()) rec.controller.abort();
  }

  private async run(
    nibbletId: string,
    rec: Active,
    userAgent: string | null,
    machine: Lender,
  ): Promise<void> {
    const { config } = this.deps;
    try {
      const params = new URLSearchParams({ onepassword: rec.onePassword ? "1" : "0" });
      if (userAgent) params.set("ua", userAgent);
      if (rec.proxyPort) params.set("proxy", `http://127.0.0.1:${rec.proxyPort}`);
      const body = new PassThrough();
      // Stream the profile up as it's packed, ending the body so the upload
      // finishes; a copy failure tears it down instead.
      void machine.archiveProfile(nibbletId, body).then(
        () => body.end(),
        (err: unknown) => body.destroy(err as Error),
      );
      const res = await this.fetch(`${config.HOST_MCP_URL}/browser/borrow?${params}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.HOST_MCP_TOKEN}`,
          "content-type": "application/gzip",
        },
        body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        duplex: "half",
        signal: rec.controller.signal,
      } as RequestInit & { duplex: "half" });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `the host bridge answered ${res.status}`);
      }
      rec.state = "handback";
      this.emit(nibbletId, rec);
      await machine.restoreProfile(
        nibbletId,
        Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      );
    } catch (err) {
      // An abort is the person ending it early; anything else is worth showing.
      if (!rec.controller.signal.aborted) {
        rec.detail = err instanceof Error ? err.message : String(err);
        console.warn(`borrow of ${nibbletId} failed`, err);
      }
    } finally {
      await this.finish(nibbletId, rec);
    }
  }

  /** Stops the proxy, starts the nibblet again, and clears the borrow. */
  private async finish(nibbletId: string, rec: Active): Promise<void> {
    await rec
      .stopProxy?.()
      .catch((err: unknown) => console.warn(`couldn't stop ${nibbletId}'s borrow proxy`, err));
    rec.stopProxy = null;
    await this.deps
      .start(nibbletId)
      .catch((err: unknown) => console.warn(`couldn't start ${nibbletId} after a borrow`, err));
    this.active.delete(nibbletId);
    this.deps.publish({ type: "browser_borrow_ended", nibbletId });
  }

  /** Asks the host bridge whether it can open a profile, and whether 1Password is there. */
  private async hostBrowser(): Promise<{ chrome: boolean; onePassword: boolean }> {
    try {
      const res = await this.fetch(`${this.deps.config.HOST_MCP_URL}/browser`, {
        headers: { authorization: `Bearer ${this.deps.config.HOST_MCP_TOKEN}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { chrome: false, onePassword: false };
      const body = (await res.json()) as { chrome?: boolean; onePassword?: boolean };
      return { chrome: Boolean(body.chrome), onePassword: Boolean(body.onePassword) };
    } catch {
      return { chrome: false, onePassword: false };
    }
  }

  private snapshot(nibbletId: string, rec: Active): BrowserBorrow {
    return {
      nibbletId,
      state: rec.state,
      detail: rec.detail,
      proxyPort: rec.proxyPort,
      onePassword: rec.onePassword,
      startedAt: rec.startedAt,
    };
  }

  private emit(nibbletId: string, rec: Active): void {
    this.deps.publish({ type: "browser_borrow", borrow: this.snapshot(nibbletId, rec) });
  }
}
