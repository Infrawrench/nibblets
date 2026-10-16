import { z } from "zod";
import { MASKED } from "./mcp.ts";
import { BROWSER_MCP_PORT, GATE_PORT, VIEW_PORT } from "./ports.ts";

/**
 * A nibblet on the user's tailnet: its container joins as a machine of its
 * own, with Tailscale in userspace networking mode, so it needs no device
 * and no capability. Servers it runs on the ports the user shares are
 * reachable from the tailnet; it reaches the tailnet through Tailscale's
 * proxy. (Not to be confused with `TailscaleStatus`, the host's own
 * Tailscale, which shares the nibblet server itself.)
 */

/** Where Tailscale's SOCKS5 and HTTP proxy listens, inside each container. */
export const TAILSCALE_PROXY_PORT = 1055;
/** The user Tailscale runs as: neither the agent nor the guard. */
export const TAILSCALE_UID = 1200;
export const TAILSCALE_GID = 1200;
/**
 * Where Tailscale keeps its state (the machine's keys): a volume of its own,
 * outside the agent's home, where the agent could swap in state of its own.
 */
export const CONTAINER_TAILSCALE_STATE = "/var/lib/nibblet-tailscale";

/**
 * Shared ports are below where sub-agents' ports start (`SUBAGENT_PORTS` in
 * the runner's entry), and so below Linux's ephemeral range too, where the
 * runner's own MCP servers and the harnesses listen.
 */
export const MAX_TAILNET_PORT = 19_999;
/** Ports in the container the tailnet can never reach: the browser's MCP endpoint, `GATE_PORT`, `VIEW_PORT` and the proxy. */
export const RESERVED_TAILNET_PORTS: readonly number[] = [
  BROWSER_MCP_PORT,
  GATE_PORT,
  VIEW_PORT,
  TAILSCALE_PROXY_PORT,
];

export const TailnetPort = z
  .int()
  .min(1)
  .max(MAX_TAILNET_PORT, `Share ports below ${MAX_TAILNET_PORT + 1}`)
  .refine((p) => !RESERVED_TAILNET_PORTS.includes(p), {
    message: `Ports ${RESERVED_TAILNET_PORTS.join(", ")} are the container's own`,
  });

/** A machine name Tailscale will take as it is: lower case letters, digits and hyphens. */
export const TailnetHostname = z
  .string()
  .max(63)
  .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?)?$/, "Use lower case letters, digits and hyphens");

export const NibbletTailscale = z.object({
  /**
   * A Tailscale auth key (`tskey-auth-…`), or empty to have one made with the
   * server's OAuth client (`TailnetKeys`) when it joins. It's only needed to
   * join: the machine stays signed in between restarts. A secret: the API
   * shows it as `MASKED`, and an update that sends `MASKED` back keeps it.
   */
  authKey: z.string().max(500),
  /** Its machine name on the tailnet; empty for one made from its name. */
  hostname: TailnetHostname.default(""),
  /** Ports the tailnet can reach. Nothing else in the container is. */
  ports: z
    .array(TailnetPort)
    .max(20)
    .default([])
    .transform((ports) => [...new Set(ports)].sort((a, b) => a - b)),
});
export type NibbletTailscale = z.infer<typeof NibbletTailscale>;

/** How its machine on the tailnet is doing, as its container last said. */
export const TailnetNode = z.object({
  state: z.enum(["starting", "running", "needs_login", "error"]),
  /** Its MagicDNS name, e.g. `scamp.tail1234.ts.net`. */
  dnsName: z.string().nullable(),
  ips: z.array(z.string()),
  tailnet: z.string().nullable(),
  detail: z.string().nullable(),
});
export type TailnetNode = z.infer<typeof TailnetNode>;

/** What the container's Tailscale fetches from the server, at `/guard/:id/tailscale`. */
export const TailscaleLogin = z.object({
  hostname: z.string(),
  ports: z.array(z.int()),
  /**
   * Stands for where its key comes from (its own key, or the OAuth client),
   * so a change of key, perhaps to another tailnet, signs in again. Null when
   * there's no key to be had: a machine that's already in stays in.
   */
  keyId: z.string().nullable(),
});
export type TailscaleLogin = z.infer<typeof TailscaleLogin>;

/** A key to join with, fetched at `/guard/:id/tailscale/key` only when signing in. */
export const TailscaleAuthKey = z.object({ authKey: z.string() });

export const TailnetTag = z.string().regex(/^tag:[a-z][a-z0-9-]*$/i, "Tags look like tag:nibblet");

/**
 * A Tailscale OAuth client (with the Auth Keys write scope) the server makes
 * a key with for each nibblet that joins without one of its own: single use,
 * pre-approved, good for an hour, and tagged, as Tailscale requires of keys an
 * OAuth client makes. The client's secret never leaves the server.
 */
export const TailnetOAuth = z.object({
  clientId: z.string().trim().min(1).max(200),
  /** `MASKED` in what the API returns; sending it back keeps the stored secret. */
  clientSecret: z.string().trim().min(1).max(500),
  tags: z.array(TailnetTag).min(1, "Give at least one tag").max(10),
});
export type TailnetOAuth = z.infer<typeof TailnetOAuth>;

export const TailnetKeys = z.object({ oauth: TailnetOAuth.nullable() });
export type TailnetKeys = z.infer<typeof TailnetKeys>;

/** A machine name made from a nibblet's name, for when it isn't given one. */
export function tailnetHostname(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return slug || "nibblet";
}

/** Applies an update from the masked view: an auth key equal to `MASKED` keeps the stored one. */
export function mergeTailscale(
  incoming: NibbletTailscale,
  stored: NibbletTailscale | null,
): NibbletTailscale {
  const authKey = incoming.authKey === MASKED ? (stored?.authKey ?? "") : incoming.authKey.trim();
  return { ...incoming, authKey };
}
