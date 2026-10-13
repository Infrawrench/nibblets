import { z } from "zod";

/**
 * Remotely managed Cloudflare Tunnels, one per linked server, like T3
 * Connect's. Tunnels and DNS records have no Worker binding, so this is the
 * Cloudflare API. Only used when a zone is configured; otherwise servers run
 * quick tunnels and report their trycloudflare.com address.
 */

export interface TunnelEnv {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_ZONE_NAME: string;
}

export function tunnelsConfigured(env: TunnelEnv): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID && env.CF_ZONE_NAME);
}

const Envelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() })).default([]),
  result: z.unknown(),
});

async function api(env: TunnelEnv, method: string, path: string, body?: object): Promise<unknown> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = Envelope.safeParse(await res.json().catch(() => null));
  if (!parsed.success || !parsed.data.success) {
    const why = parsed.success
      ? parsed.data.errors.map((e) => e.message).join("; ")
      : res.statusText;
    throw new Error(`Cloudflare API ${method} ${path}: ${why}`);
  }
  return parsed.data.result;
}

export interface CreatedTunnel {
  tunnelId: string;
  dnsRecordId: string;
  hostname: string;
  token: string;
}

/**
 * A tunnel whose ingress sends `<serverId>.<zone>` to the nibblet server on
 * its own Docker network, where the server's cloudflared runs.
 */
export async function createTunnel(env: TunnelEnv, serverId: string): Promise<CreatedTunnel> {
  const account = `/accounts/${env.CF_ACCOUNT_ID}`;
  const hostname = `${serverId.toLowerCase().replaceAll("_", "-")}.${env.CF_ZONE_NAME}`;
  const tunnel = z.object({ id: z.string() }).parse(
    await api(env, "POST", `${account}/cfd_tunnel`, {
      name: `nibblet-${serverId}`,
      config_src: "cloudflare",
    }),
  );
  await api(env, "PUT", `${account}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [{ hostname, service: "http://server:8420" }, { service: "http_status:404" }],
    },
  });
  const token = z.string().parse(await api(env, "GET", `${account}/cfd_tunnel/${tunnel.id}/token`));
  const record = z.object({ id: z.string() }).parse(
    await api(env, "POST", `/zones/${env.CF_ZONE_ID}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      comment: `Nibblets Connect server ${serverId}`,
    }),
  );
  return { tunnelId: tunnel.id, dnsRecordId: record.id, hostname, token };
}

/** Removes a server's tunnel and its DNS record. Best effort: either may already be gone. */
export async function deleteTunnel(
  env: TunnelEnv,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  if (!tunnelsConfigured(env)) return;
  const account = `/accounts/${env.CF_ACCOUNT_ID}`;
  if (dnsRecordId) {
    await api(env, "DELETE", `/zones/${env.CF_ZONE_ID}/dns_records/${dnsRecordId}`).catch(
      () => undefined,
    );
  }
  if (tunnelId) {
    await api(env, "DELETE", `${account}/cfd_tunnel/${tunnelId}/connections`).catch(
      () => undefined,
    );
    await api(env, "DELETE", `${account}/cfd_tunnel/${tunnelId}`).catch(() => undefined);
  }
}
