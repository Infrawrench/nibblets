import {
  ConnectStatus,
  HEARTBEAT_EVERY_MS,
  HeartbeatResponse,
  LinkPollResponse,
  LinkStartResponse,
  ManagedTunnel,
  ServerTokenClaims,
  type HeartbeatRequest,
  type ServerRoutes,
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

interface Pending {
  code: string;
  approveUrl: string;
  pollToken: string;
  expiresAt: string;
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

  /** Picks up an earlier link after a restart. */
  async restore(): Promise<void> {
    const saved = await this.deps.store.getSetting(SETTING, (v) => Link.parse(v), null);
    if (saved) await this.activate(saved);
  }

  async start(): Promise<ConnectStatus> {
    if (this.link) return this.status();
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
    this.pending = { ...started, timer: null };
    this.schedulePoll(started.intervalSeconds * 1000);
    return this.status();
  }

  cancel(): ConnectStatus {
    this.cancelPending();
    return this.status();
  }

  async unlink(): Promise<ConnectStatus> {
    const link = this.link;
    this.cancelPending();
    if (link) {
      // Best effort: the central side also forgets servers that stop beating.
      await this.fetch(`${link.centralUrl}/v1/servers/${link.serverId}/unlink`, {
        method: "POST",
        headers: { authorization: `Bearer ${link.serverSecret}` },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    }
    await this.forget();
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

  stop(): void {
    this.cancelPending();
    if (this.beat) clearTimeout(this.beat);
    this.beat = null;
  }

  private cancelPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private schedulePoll(ms: number): void {
    const pending = this.pending;
    if (!pending) return;
    pending.timer = setTimeout(() => void this.poll(pending), ms);
  }

  private async poll(pending: Pending): Promise<void> {
    if (this.pending !== pending) return;
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pending = null;
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
          this.pending = null;
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
          await this.deps.store.setSetting(SETTING, link);
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
    this.link = link;
    this.jwks = null;
    await this.deps.tunnel
      .configure(
        link.tunnel
          ? { mode: "token", token: link.tunnel.token, hostname: link.tunnel.hostname }
          : { mode: "quick" },
      )
      .catch((err: unknown) => {
        this.lastError = `Tunnel: ${err instanceof Error ? err.message : String(err)}`;
      });
    this.scheduleBeat(0);
  }

  private async forget(): Promise<void> {
    if (this.beat) clearTimeout(this.beat);
    this.beat = null;
    this.link = null;
    this.jwks = null;
    this.lastHeartbeatAt = null;
    this.lastError = null;
    this.routes = { lan: [], tailscale: null, tunnel: null };
    await this.deps.store.deleteSetting(SETTING);
    await this.deps.tunnel.configure({ mode: "off" }).catch(() => undefined);
  }

  private scheduleBeat(ms: number): void {
    if (this.beat) clearTimeout(this.beat);
    this.beat = setTimeout(() => void this.heartbeat(), ms);
  }

  async currentRoutes(): Promise<ServerRoutes> {
    const tunnel = this.deps.tunnel.current();
    return {
      lan: this.deps.config.NIBBLET_LAN_URLS,
      tailscale: await this.deps.tailscaleUrl().catch(() => null),
      tunnel: tunnel.state === "up" ? tunnel.url : null,
    };
  }

  private async heartbeat(): Promise<void> {
    const link = this.link;
    if (!link) return;
    try {
      this.routes = await this.currentRoutes();
      const body: HeartbeatRequest = {
        name: await this.deps.serverName(),
        version: this.deps.version,
        nibblets: await this.deps.nibbletCount(),
        routes: this.routes,
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
      if (res.status === 401 || res.status === 404) {
        // The account removed this server.
        await this.forget();
        return;
      }
      if (!res.ok) throw new Error(`heartbeat answered ${res.status}`);
      if (!HeartbeatResponse.parse(await res.json()).linked) {
        await this.forget();
        return;
      }
      this.lastHeartbeatAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    if (this.link !== link) return;
    // A quick tunnel takes a few seconds to get its address; report it promptly.
    this.scheduleBeat(this.routes.tunnel || link.tunnel ? HEARTBEAT_EVERY_MS : 5000);
  }
}
