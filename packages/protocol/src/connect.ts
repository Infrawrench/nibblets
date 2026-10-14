import { z } from "zod";

/*
 * Nibblets Connect: the central service where you sign in and see every
 * server you run. Shared by the central Worker (apps/connect), the servers
 * that link to it, and the UI. Like T3 Connect, the central service is not in
 * the data path: it hands out addresses and short-lived tokens, and the
 * browser then talks to each server directly.
 */

/** The ways a server can be reached, best first: same network, tailnet, then the internet. */
export const ServerRoutes = z.object({
  lan: z.array(z.url()),
  tailscale: z.url().nullable(),
  tunnel: z.url().nullable(),
});
export type ServerRoutes = z.infer<typeof ServerRoutes>;

export const noRoutes: ServerRoutes = { lan: [], tailscale: null, tunnel: null };

/** Every route in the order a client should try them. */
export function routeOrder(routes: ServerRoutes): { kind: RouteKind; url: string }[] {
  return [
    ...routes.lan.map((url) => ({ kind: "lan" as const, url })),
    ...(routes.tailscale ? [{ kind: "tailscale" as const, url: routes.tailscale }] : []),
    ...(routes.tunnel ? [{ kind: "tunnel" as const, url: routes.tunnel }] : []),
  ];
}
export type RouteKind = "lan" | "tailscale" | "tunnel";

export const Platform = z.enum(["darwin", "linux", "win32", "other"]);

// The link flow, like `t3 connect`: the server asks for a code, the person
// approves it on the central site while signed in, the server collects its
// credentials by polling.

export const LinkStartRequest = z.object({
  name: z.string().min(1).max(80),
  hostname: z.string().max(253),
  platform: Platform,
});

export const LinkStartResponse = z.object({
  /** Shown on both sides so the person can check they're approving the right server. */
  code: z.string(),
  approveUrl: z.url(),
  pollToken: z.string(),
  expiresAt: z.iso.datetime(),
  intervalSeconds: z.int(),
});
export type LinkStartResponse = z.infer<typeof LinkStartResponse>;

/** A remotely managed Cloudflare Tunnel the central service made for this server. */
export const ManagedTunnel = z.object({ token: z.string(), hostname: z.string() });
export type ManagedTunnel = z.infer<typeof ManagedTunnel>;

export const LinkPollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("denied") }),
  z.object({
    status: z.literal("approved"),
    serverId: z.string(),
    serverSecret: z.string(),
    centralUrl: z.url(),
    account: z.string(),
    /** Null when the central service has no zone to put tunnels in; use a quick tunnel. */
    tunnel: ManagedTunnel.nullable(),
  }),
]);
export type LinkPollResponse = z.infer<typeof LinkPollResponse>;

/** What the approve page shows about a pending link. */
export const PendingLink = z.object({
  code: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: Platform,
  expiresAt: z.iso.datetime(),
});
export type PendingLink = z.infer<typeof PendingLink>;

export const HeartbeatRequest = z.object({
  name: z.string().min(1).max(80),
  version: z.string(),
  nibblets: z.int().min(0),
  routes: ServerRoutes,
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  /** False once the account has removed this server: it should forget its link. */
  linked: z.boolean(),
  /**
   * The service's canonical address. When it moves (a custom domain, say),
   * linked servers follow, since tokens name it as their issuer.
   */
  centralUrl: z.url().optional(),
});

/** A server as the central service lists it to its owner. */
export const CentralServer = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: Platform,
  version: z.string().nullable(),
  nibblets: z.int(),
  routes: ServerRoutes,
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  linkedAt: z.iso.datetime(),
});
export type CentralServer = z.infer<typeof CentralServer>;

/**
 * A server asking the central service to tell its owner something on their
 * devices, like a nibblet needing an approval. The central service sends it
 * as a push notification that opens that nibblet.
 */
export const PushNote = z.object({
  nibbletId: z.string().max(64),
  title: z.string().min(1).max(120),
  body: z.string().max(400),
  /** Notes with the same tag replace each other rather than piling up. */
  tag: z.string().max(80),
});
export type PushNote = z.infer<typeof PushNote>;

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export const PushSubscriptionInput = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
  /** Which device, so the person can tell them apart. */
  label: z.string().max(80).optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** A short-lived credential for one server, minted by the central service. */
export const ServerToken = z.object({ token: z.string(), expiresAt: z.iso.datetime() });
export type ServerToken = z.infer<typeof ServerToken>;

/** Claims in a central-minted token, beyond the registered ones. */
export const ServerTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string(),
  exp: z.number(),
  /** Display name or email of the signed-in person. */
  name: z.string().optional(),
});

/** How long a server may go without a heartbeat before it's shown as offline. */
export const OFFLINE_AFTER_MS = 90_000;
export const HEARTBEAT_EVERY_MS = 30_000;

// What a server's own UI shows about its link.

export const ConnectStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unlinked"), centralUrl: z.url() }),
  z.object({
    state: z.literal("linking"),
    centralUrl: z.url(),
    code: z.string(),
    approveUrl: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    state: z.literal("linked"),
    centralUrl: z.url(),
    serverId: z.string(),
    account: z.string(),
    routes: ServerRoutes,
    managedTunnel: z.boolean(),
    lastHeartbeatAt: z.iso.datetime().nullable(),
    lastError: z.string().nullable(),
  }),
]);
export type ConnectStatus = z.infer<typeof ConnectStatus>;

export const TailscaleStatus = z.object({
  installed: z.boolean(),
  /** Signed in and connected to a tailnet. */
  running: z.boolean(),
  /** Whether this server is shared on the tailnet with `tailscale serve`. */
  serving: z.boolean(),
  url: z.string().nullable(),
  detail: z.string().nullable(),
  /** Something the person has to do in their browser, shown as a button. */
  action: z.object({ label: z.string(), url: z.url() }).nullable(),
});
export type TailscaleStatus = z.infer<typeof TailscaleStatus>;
