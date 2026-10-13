import { z } from "zod";
import type { Run } from "./clis/cli.ts";

/**
 * Tailscale on the host. With it, the bridge shares the nibblet server on the
 * tailnet with `tailscale serve` (HTTPS, a MagicDNS name, Tailscale's own
 * certificate), the way T3 Code's `--tailscale-serve` does, and reports the
 * address so the server can offer it as a route.
 */

export interface TailscaleState {
  installed: boolean;
  running: boolean;
  serving: boolean;
  url: string | null;
  detail: string | null;
}

/** Where the CLI lives: on PATH, or inside the macOS app. */
const CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

const Status = z.looseObject({
  BackendState: z.string(),
  Self: z.looseObject({ DNSName: z.string().optional() }).optional(),
});

const ServeStatus = z.looseObject({
  Web: z
    .record(
      z.string(),
      z.looseObject({
        Handlers: z.record(z.string(), z.looseObject({ Proxy: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The tailnet name of this machine, without MagicDNS's trailing dot. */
export function parseTailscaleStatus(text: string): { running: boolean; dnsName: string | null } {
  const parsed = Status.safeParse(parseJson(text));
  if (!parsed.success) return { running: false, dnsName: null };
  const dns = parsed.data.Self?.DNSName?.replace(/\.$/, "") || null;
  return { running: parsed.data.BackendState === "Running", dnsName: dns };
}

/** Whether `tailscale serve` is already proxying HTTPS to `target`. */
export function parseServeStatus(text: string, target: string): boolean {
  const parsed = ServeStatus.safeParse(parseJson(text));
  if (!parsed.success) return false;
  return Object.values(parsed.data.Web ?? {}).some((site) =>
    Object.values(site.Handlers ?? {}).some((h) => h.Proxy?.replace(/\/$/, "") === target),
  );
}

async function findCli(run: Run): Promise<string | null> {
  for (const cli of CANDIDATES) {
    if ((await run(cli, ["version"])).code === 0) return cli;
  }
  return null;
}

export async function tailscaleState(run: Run, target: string): Promise<TailscaleState> {
  const cli = await findCli(run);
  if (!cli) {
    return { installed: false, running: false, serving: false, url: null, detail: null };
  }
  const { running, dnsName } = parseTailscaleStatus((await run(cli, ["status", "--json"])).stdout);
  if (!running || !dnsName) {
    return {
      installed: true,
      running: false,
      serving: false,
      url: null,
      detail: "Tailscale isn't connected. Sign in to it on this computer.",
    };
  }
  const serving = parseServeStatus((await run(cli, ["serve", "status", "--json"])).stdout, target);
  return {
    installed: true,
    running: true,
    serving,
    url: serving ? `https://${dnsName}` : null,
    detail: null,
  };
}

/** Starts or stops sharing `target` on the tailnet over HTTPS. */
export async function setTailscaleServe(
  run: Run,
  target: string,
  serving: boolean,
): Promise<TailscaleState> {
  const cli = await findCli(run);
  if (!cli) return tailscaleState(run, target);
  const args = serving ? ["serve", "--bg", "--https=443", target] : ["serve", "--https=443", "off"];
  const result = await run(cli, args);
  const state = await tailscaleState(run, target);
  if (result.code !== 0 && state.serving !== serving) {
    const why = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    return { ...state, detail: why ? `tailscale serve failed: ${why}` : "tailscale serve failed" };
  }
  return state;
}
