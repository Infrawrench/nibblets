import {
  ConnectStatus,
  HEARTBEAT_EVERY_MS,
  HeartbeatResponse,
  LinkPollResponse,
  LinkStartResponse,
  ManagedTunnel,
  ServerTokenClaims,
  type HeartbeatRequest,
  type PushNote,
  type ServerRoutes,
  type TunnelConfig,
  type TunnelStatus,
} from "@nibblet/protocol";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { Tunnel } from "./tunnel.ts";

/** What a linked server remembers about its account. */
const Link = z.object({
  centralUrl: z.url(),
  serverId: z.string(),
  serverSecret: z.string(),
  account: z.string(),
  tunnel: ManagedTunnel.nullable(),
  linkedAt: z.iso.datetime(),
});
type Link = z.infer<typeof Link>;

const SETTING = "connect";

/**
 * A link code waiting for approval. It's kept so a restart mid-link (say the
 * app updating) still collects the approval, rather than leaving the account
 * with a server that never comes online.
 */
const SavedPending = z.object({
  code: z.string(),
  approveUrl: z.string(),
  pollToken: z.string(),
  expiresAt: z.iso.datetime(),
});
const PENDING_SETTING = "connect.pending";

interface Pending extends z.infer<typeof SavedPending> {
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectDeps {
  store: Pick<Store, "getSetting" | "setSetting" | "deleteSetting">;
  tunnel: Pick<Tunnel, "configure" | "current">;
  config: Pick<
    Config,
    "NIBBLET_CENTRAL_URL" | "NIBBLET_HOST_NAME" | "NIBBLET_HOST_PLATFORM" | "NIBBLET_LAN_URLS"
  >;
  version: string;
  serverName: () => Promise<string>;
  nibbletCount: () => Promise<number>;
  /** The tailnet address, when the host bridge is serving this server on Tailscale. */
  tailscaleUrl: () => Promise<string | null>;
  fetch?: typeof fetch;
}

/**
 * This server's side of Nibblets Connect. It links to an account with a
 * code the person approves on the central site, then keeps the central
 * service told how to reach it (heartbeats with its routes), runs the tunnel
 * the central service made for it (or a quick one), and accepts the
 * short-lived tokens the central service mints for its owner.
 */
export class Connect {
  private link: Link | null = null;
  private pending: Pending | null = null;
  private beat: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private linkWrites: Promise<void> = Promise.resolve();
  private tunnelWrites: Promise<void> = Promise.resolve();
  private lastHeartbeatAt: string | null = null;
  private lastError: string | null = null;
  private routes: ServerRoutes = { lan: [], tailscale: null, tunnel: null };
  private jwks: { url: string; get: JWTVerifyGetKey } | null = null;
  private readonly deps: ConnectDeps;
  private readonly fetch: typeof fetch;

  constructor(deps: ConnectDeps) {
    this.deps = deps;
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  private get centralUrl(): string {
    return (this.link?.centralUrl ?? this.deps.config.NIBBLET_CENTRAL_URL).replace(/\/+$/, "");
  }

  status(): ConnectStatus {
    if (this.link) {
      return {
        state: "linked",
        centralUrl: this.link.centralUrl,
        serverId: this.link.serverId,
        account: this.link.account,
        routes: this.routes,
        managedTunnel: this.link.tunnel !== null,
        lastHeartbeatAt: this.lastHeartbeatAt,
        lastError: this.lastError,
      };
    }
    if (this.pending && Date.parse(this.pending.expiresAt) > Date.now()) {
      return {
        state: "linking",
        centralUrl: this.centralUrl,
        code: this.pending.code,
        approveUrl: this.pending.approveUrl,
        expiresAt: this.pending.expiresAt,
      };
    }
    return { state: "unlinked", centralUrl: this.centralUrl };
  }

  /** Picks up an earlier link, or a code still waiting for approval, after a restart. */
  async restore(): Promise<void> {
    const saved = await this.deps.store.getSetting(SETTING, (v) => Link.parse(v), null);
    if (saved) {
      await this.activate(saved);
      return;
    }
    const pending = await this.deps.store.getSetting(
      PENDING_SETTING,
      (v) => SavedPending.parse(v),
      null,
    );
    if (pending && Date.parse(pending.expiresAt) > Date.now()) {
      this.pending = { ...pending, timer: null };
      this.schedulePoll(0);
    } else if (pending) {
      await this.deps.store.deleteSetting(PENDING_SETTING);
    }
  }

  async start(): Promise<ConnectStatus> {
    if (this.link) return this.status();
    // A code that's still live may already be approved; starting over would orphan it.
    if (this.pending && Date.parse(this.pending.expiresAt) > Date.now()) return this.status();
    this.cancelPending();
    const res = await this.fetch(`${this.centralUrl}/v1/link/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: await this.deps.serverName(),
        hostname: this.deps.config.NIBBLET_HOST_NAME,
        platform: this.deps.config.NIBBLET_HOST_PLATFORM,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Nibblets Connect refused to start linking (${res.status})`);
    const started = LinkStartResponse.parse(await res.json());
    const saved = {
      code: started.code,
      approveUrl: started.approveUrl,
      pollToken: started.pollToken,
      expiresAt: started.expiresAt,
    };
    await this.deps.store.setSetting(PENDING_SETTING, saved);
    this.pending = { ...saved, timer: null };
    this.schedulePoll(started.intervalSeconds * 1000);
    return this.status();
  }

  async cancel(): Promise<ConnectStatus> {
    await this.dropPending();
    return this.status();
  }

  async unlink(): Promise<ConnectStatus> {
    const link = this.link;
    this.stop();
    const generation = this.generation;
    try {
      await this.dropPending();
    } catch (err) {
      if (this.generation === generation && this.link) this.scheduleBeat(0, generation);
      throw err;
    }
    if (this.generation !== generation) return this.status();
    if (link) {
      // Best effort: the central side also forgets servers that stop beating.
      await this.fetch(`${link.centralUrl}/v1/servers/${link.serverId}/unlink`, {
        method: "POST",
        headers: { authorization: `Bearer ${link.serverSecret}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    if (this.generation === generation) await this.forget();
    return this.status();
  }

  /**
   * Checks a token the central service minted for this server's owner.
   * Returns who it's for, or null if it isn't one.
   */
  async verify(token: string): Promise<{ sub: string; name: string | null } | null> {
    const link = this.link;
    if (!link || token.split(".").length !== 3) return null;
    const jwksUrl = `${link.centralUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;
    if (this.jwks?.url !== jwksUrl) {
      this.jwks = { url: jwksUrl, get: createRemoteJWKSet(new URL(jwksUrl)) };
    }
    try {
      const { payload } = await jwtVerify(token, this.jwks.get, {
        issuer: link.centralUrl.replace(/\/+$/, ""),
        audience: link.serverId,
      });
      const claims = ServerTokenClaims.parse(payload);
      return { sub: claims.sub, name: claims.name ?? null };
    } catch {
      return null;
    }
  }

  /**
   * Tells the person on their phone and other devices, through the central
   * service. Does nothing when this server isn't linked; a note that doesn't
   * get through isn't retried, since it'd be stale by then.
   */
  async notify(note: PushNote): Promise<boolean> {
    const link = this.link;
    if (!link) return false;
    const res = await this.fetch(`${link.centralUrl}/v1/servers/${link.serverId}/notify`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${link.serverSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(note),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    return res?.ok ?? false;
  }

  stop(): void {
    this.generation++;
    this.cancelPending();
    if (this.beat) clearTimeout(this.beat);
    this.beat = null;
  }

  private cancelPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private async dropPending(): Promise<void> {
    this.cancelPending();
    await this.deps.store.deleteSetting(PENDING_SETTING);
  }

  private schedulePoll(ms: number): void {
    const pending = this.pending;
    if (!pending) return;
    pending.timer = setTimeout(() => void this.poll(pending), ms);
  }

  private async poll(pending: Pending): Promise<void> {
    if (this.pending !== pending) return;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await this.dropPending();
      return;
    }
    try {
      const res = await this.fetch(`${this.centralUrl}/v1/link/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${pending.pollToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const answer = LinkPollResponse.parse(await res.json());
      if (this.pending !== pending) return;
      switch (answer.status) {
        case "pending":
          this.schedulePoll(2000);
          return;
        case "expired":
        case "denied":
          await this.dropPending();
          return;
        case "approved": {
          this.pending = null;
          const link: Link = {
            centralUrl: answer.centralUrl.replace(/\/+$/, ""),
            serverId: answer.serverId,
            serverSecret: answer.serverSecret,
            account: answer.account,
            tunnel: answer.tunnel,
            linkedAt: new Date().toISOString(),
          };
          const generation = this.generation;
          await this.persistLink(link, generation);
          if (this.generation !== generation) return;
          await this.deps.store.deleteSetting(PENDING_SETTING);
          if (this.generation !== generation) return;
          await this.activate(link);
          return;
        }
      }
    } catch {
      // The central service may be briefly away; keep asking until the code expires.
      this.schedulePoll(4000);
    }
  }

  /** Runs the tunnel and starts telling the central service where to find this server. */
  private async activate(link: Link): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.link = link;
    this.jwks = null;
    this.scheduleBeat(0, generation);
    await this.configureTunnel(
      link.tunnel
        ? { mode: "token", token: link.tunnel.token, hostname: link.tunnel.hostname }
        : { mode: "quick" },
    ).catch((err: unknown) => {
      if (this.generation !== generation) return;
      this.lastError = `Tunnel: ${err instanceof Error ? err.message : String(err)}`;
    });
  }

  /**
   * Applies tunnel settings one at a time. The first heartbeat can forget the
   * link while activation's setup is still running, and an "off" that finished
   * first would leave that setup's tunnel up.
   */
  private configureTunnel(config: TunnelConfig): Promise<TunnelStatus> {
    const write = this.tunnelWrites.then(() => this.deps.tunnel.configure(config));
    this.tunnelWrites = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private persistLink(link: Link | null, generation: number): Promise<void> {
    const write = this.linkWrites.then(() => {
      if (this.generation !== generation) return;
      return link
        ? this.deps.store.setSetting(SETTING, link)
        : this.deps.store.deleteSetting(SETTING);
    });
    // A failed write reaches its caller without preventing a later unlink deletion.
    this.linkWrites = write.catch(() => undefined);
    return write;
  }

  private async forget(): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.link = null;
    this.jwks = null;
    this.lastHeartbeatAt = null;
    this.lastError = null;
    this.routes = { lan: [], tailscale: null, tunnel: null };
    await this.persistLink(null, generation);
    if (this.generation !== generation) return;
    await this.configureTunnel({ mode: "off" }).catch(() => undefined);
  }

  private scheduleBeat(ms: number, generation: number): void {
    if (this.generation !== generation) return;
    if (this.beat) clearTimeout(this.beat);
    this.beat = setTimeout(() => void this.heartbeat(generation), ms);
  }

  async currentRoutes(): Promise<ServerRoutes> {
    const tunnel = this.deps.tunnel.current();
    return {
      lan: this.deps.config.NIBBLET_LAN_URLS,
      tailscale: await this.deps.tailscaleUrl().catch(() => null),
      tunnel: tunnel.state === "up" ? tunnel.url : null,
    };
  }

  private async heartbeat(generation: number): Promise<void> {
    const link = this.link;
    if (!link || this.generation !== generation) return;
    try {
      const routes = await this.currentRoutes();
      if (this.generation !== generation) return;
      this.routes = routes;
      const name = await this.deps.serverName();
      if (this.generation !== generation) return;
      const nibblets = await this.deps.nibbletCount();
      if (this.generation !== generation) return;
      const body: HeartbeatRequest = {
        name,
        version: this.deps.version,
        nibblets,
        routes,
      };
      const res = await this.fetch(`${link.centralUrl}/v1/servers/${link.serverId}/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${link.serverSecret}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (this.generation !== generation) return;
      if (res.status === 401 || res.status === 404) {
        // The account removed this server.
        await this.forget();
        return;
      }
      if (!res.ok) throw new Error(`heartbeat answered ${res.status}`);
      const answer = HeartbeatResponse.parse(await res.json());
      if (this.generation !== generation) return;
      if (!answer.linked) {
        await this.forget();
        return;
      }
      // The service moved address; tokens it issues now name the new one.
      const moved = answer.centralUrl?.replace(/\/+$/, "");
      const safe = moved && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(`${moved}/`);
      if (moved && safe && moved !== link.centralUrl) {
        await this.persistLink({ ...link, centralUrl: moved }, generation);
        if (this.generation !== generation) return;
        link.centralUrl = moved;
      }
      this.lastHeartbeatAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      if (this.generation !== generation) return;
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    if (this.generation !== generation) return;
    // Either tunnel kind takes a few seconds to come up; report its address promptly.
    this.scheduleBeat(this.routes.tunnel ? HEARTBEAT_EVERY_MS : 5000, generation);
  }
}
