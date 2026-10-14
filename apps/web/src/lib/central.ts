import { z } from "zod";
import {
  CentralServer,
  PendingLink,
  ServerToken,
  routeOrder,
  type PushSubscriptionInput,
  type RouteKind,
  type ServerRoutes,
} from "@nibblet/protocol";

/*
 * Central mode: the UI served by Nibblets Connect. It lists the signed-in
 * person's servers and talks to each one directly, over the best route that
 * answers, with a five-minute token the central service mints for it.
 */

export const CentralConfig = z.object({
  clerkPublishableKey: z.string(),
  centralUrl: z.string(),
  /** `wrangler dev` with DEV_AUTH_USER: signed in without Clerk. */
  devAuth: z.boolean(),
  /** For push notifications; null when the service has none set up. */
  vapidPublicKey: z.string().nullable().default(null),
});
export type CentralConfig = z.infer<typeof CentralConfig>;

export function isCentralMode(): boolean {
  return import.meta.env.VITE_NIBBLET_MODE === "central";
}

export async function loadCentralConfig(): Promise<CentralConfig> {
  const res = await fetch("/v1/config");
  if (!res.ok) throw new Error(`Nibblets Connect isn't answering (${res.status})`);
  return CentralConfig.parse(await res.json());
}

const ServerList = z.object({
  user: z.object({ id: z.string(), name: z.string() }),
  servers: z.array(CentralServer),
});
export type ServerList = z.infer<typeof ServerList>;

export interface CentralApi {
  servers(): Promise<ServerList>;
  token(serverId: string): Promise<ServerToken>;
  pendingLink(code: string): Promise<PendingLink>;
  /** `startedItMyself` is needed when the server asked from another network. */
  approve(code: string, startedItMyself: boolean): Promise<void>;
  deny(code: string): Promise<void>;
  rename(serverId: string, name: string): Promise<void>;
  remove(serverId: string): Promise<void>;
  subscribePush(subscription: PushSubscriptionInput): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  testPush(): Promise<{ sent: number; failed: number }>;
  /** Leaves this sign-in for the desktop app that sent `challenge`; returns the handle it collects it with. */
  desktopSignIn(challenge: string): Promise<{ handle: string }>;
}

const DesktopHandle = z.object({ handle: z.string() });

const PushTestResult = z.object({ sent: z.number(), failed: z.number() });

const ErrorBody = z.object({ error: z.string() });

/** The central service's API, on this page's own origin, signed in with a Clerk session. */
export function centralApi(sessionToken: () => Promise<string | null>): CentralApi {
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const token = await sessionToken();
    const res = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(body);
      throw new Error(parsed.success ? parsed.data.error : `${res.status} ${res.statusText}`);
    }
    return body;
  };
  return {
    servers: async () => ServerList.parse(await call("/v1/servers")),
    token: async (id) =>
      ServerToken.parse(
        await call(`/v1/servers/${encodeURIComponent(id)}/token`, { method: "POST" }),
      ),
    pendingLink: async (code) =>
      PendingLink.parse(await call(`/v1/link/${encodeURIComponent(code)}`)),
    approve: async (code, startedItMyself) => {
      await call(`/v1/link/${encodeURIComponent(code)}/approve`, {
        method: "POST",
        body: JSON.stringify({ startedItMyself }),
      });
    },
    deny: async (code) => {
      await call(`/v1/link/${encodeURIComponent(code)}/deny`, { method: "POST" });
    },
    rename: async (id, name) => {
      await call(`/v1/servers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    },
    subscribePush: async (subscription) => {
      await call("/v1/push/subscriptions", { method: "POST", body: JSON.stringify(subscription) });
    },
    unsubscribePush: async (endpoint) => {
      await call("/v1/push/subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint }),
      });
    },
    testPush: async () => PushTestResult.parse(await call("/v1/push/test", { method: "POST" })),
    desktopSignIn: async (challenge) =>
      DesktopHandle.parse(
        await call("/v1/desktop/sign-in", { method: "POST", body: JSON.stringify({ challenge }) }),
      ),
    remove: async (id) => {
      await call(`/v1/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

/** Keeps one token per server, fetching a new one a minute before the old one runs out. */
export class TokenCache {
  private readonly tokens = new Map<string, Promise<ServerToken>>();
  private readonly api: CentralApi;

  constructor(api: CentralApi) {
    this.api = api;
  }

  async get(serverId: string): Promise<string> {
    const cached = this.tokens.get(serverId);
    if (cached) {
      const token = await cached.catch(() => null);
      if (token && Date.parse(token.expiresAt) - Date.now() > 60_000) return token.token;
    }
    const fresh = this.api.token(serverId);
    this.tokens.set(serverId, fresh);
    return (await fresh).token;
  }
}

export type Probe = (url: string) => Promise<boolean>;

/** Whether a nibblet server answers at `url`, within a couple of seconds. */
export const probeHealth: Probe = async (url) => {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** How a server is being reached: one of its routes, or this computer's own address. */
export type ChosenRouteKind = RouteKind | "local";

export interface ChosenRoute {
  kind: ChosenRouteKind;
  url: string;
}

/** Where the desktop app picks up a sign-in made in the browser (its `nibblets:` link). */
export function desktopSignInLink(state: string, handle: string): string {
  const q = new URLSearchParams({ state, handle });
  return `nibblets://sign-in?${q}`;
}

/**
 * A sign-in handed over from the browser: the desktop app opens Nibblets
 * Connect with `?signin=<now>#sign-in-ticket=…` (the query makes it a fresh
 * load). Read once, then wiped from the address.
 */
export function takeSignInTicket(): string | null {
  const match = /^#sign-in-ticket=([\w.-]+)$/.exec(window.location.hash);
  if (!match?.[1]) return null;
  const search = new URLSearchParams(window.location.search);
  search.delete("signin");
  const query = search.toString();
  history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  return match[1];
}

/** Where the desktop app's own server answers, on the computer it runs on. */
export const LOCAL_SERVER_URL = "http://127.0.0.1:8420";

/**
 * The server running on this computer, when the desktop app has one linked to
 * the account. The app says so in its user agent, which a link can't set.
 */
export function localServerId(userAgent = navigator.userAgent): string | null {
  return /\bNibbletsLocal\/([\w-]+)/.exec(userAgent)?.[1] ?? null;
}

/**
 * The first route that answers, trying the same network, then the tailnet,
 * then the tunnel, like T3 Connect's route list.
 */
export async function chooseRoute(
  routes: ServerRoutes,
  probe: Probe = probeHealth,
  local = false,
): Promise<ChosenRoute | null> {
  // On its own computer, a server is best reached without leaving it.
  const order = [
    ...(local ? [{ kind: "local" as const, url: LOCAL_SERVER_URL }] : []),
    ...routeOrder(routes),
  ];
  for (const route of order) {
    if (await probe(route.url)) return { kind: route.kind, url: route.url.replace(/\/+$/, "") };
  }
  return null;
}
