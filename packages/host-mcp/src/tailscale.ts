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
  /** Installed, but its service isn't running, so there's nothing to sign in to yet. */
  stopped: boolean;
  serving: boolean;
  url: string | null;
  detail: string | null;
  /** Something to do in a browser (sign in, turn Serve on), for the UI to show as a button. */
  action: { label: string; url: string } | null;
}

/** Where the CLI lives: on PATH, or inside the macOS app. */
const CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

const Status = z.looseObject({
  BackendState: z.string(),
  AuthURL: z.string().optional(),
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

/**
 * What `tailscale status --json` says: whether the service answered at all,
 * whether it's on a tailnet, this machine's tailnet name (without MagicDNS's
 * trailing dot), and the link of a sign-in that's already waiting.
 */
export function parseTailscaleStatus(text: string): {
  reachable: boolean;
  running: boolean;
  dnsName: string | null;
  authUrl: string | null;
} {
  const parsed = Status.safeParse(parseJson(text));
  if (!parsed.success) return { reachable: false, running: false, dnsName: null, authUrl: null };
  const dns = parsed.data.Self?.DNSName?.replace(/\.$/, "") || null;
  const authUrl = parsed.data.AuthURL?.startsWith("https://") ? parsed.data.AuthURL : null;
  return {
    reachable: true,
    running: parsed.data.BackendState === "Running",
    dnsName: dns,
    authUrl,
  };
}

/** How to start the service, for the CLI that was found. */
function startHint(cli: string): string {
  if (cli.startsWith("/Applications/") || process.platform === "win32") {
    return "Open the Tailscale app to start it.";
  }
  if (process.platform === "darwin") {
    return "Open the Tailscale app, or if it came from Homebrew, run `sudo brew services start tailscale`.";
  }
  return "Start it with `sudo systemctl start tailscaled`.";
}

/** Whether `tailscale serve` is already proxying HTTPS to `target`. */
export function parseServeStatus(text: string, target: string): boolean {
  const parsed = ServeStatus.safeParse(parseJson(text));
  if (!parsed.success) return false;
  return Object.values(parsed.data.Web ?? {}).some((site) =>
    Object.values(site.Handlers ?? {}).some((h) => h.Proxy?.replace(/\/$/, "") === target),
  );
}

/**
 * Runs the CLI against the right daemon. `TAILSCALE_SOCKET` points it at a
 * userspace `tailscaled` (one started with `--socket`), which needs no root
 * and no system extension; otherwise the CLI's default socket is used.
 */
function withSocket(run: Run, socket: string | undefined): Run {
  return socket ? (cli, args) => run(cli, [`--socket=${socket}`, ...args]) : run;
}

async function findCli(run: Run): Promise<string | null> {
  for (const cli of CANDIDATES) {
    if ((await run(cli, ["version"])).code === 0) return cli;
  }
  return null;
}

export async function tailscaleState(
  plainRun: Run,
  target: string,
  socket = process.env.TAILSCALE_SOCKET,
): Promise<TailscaleState> {
  const run = withSocket(plainRun, socket);
  const cli = await findCli(plainRun);
  if (!cli) {
    return {
      installed: false,
      running: false,
      stopped: false,
      serving: false,
      url: null,
      detail: null,
      action: null,
    };
  }
  const { reachable, running, dnsName, authUrl } = parseTailscaleStatus(
    (await run(cli, ["status", "--json"])).stdout,
  );
  if (!reachable) {
    return {
      installed: true,
      running: false,
      stopped: true,
      serving: false,
      url: null,
      detail: `Tailscale is installed but isn't running. ${startHint(cli)}`,
      action: null,
    };
  }
  if (!running || !dnsName) {
    return {
      installed: true,
      running: false,
      stopped: false,
      serving: false,
      url: null,
      detail: "Tailscale isn't signed in on this computer.",
      action: authUrl ? { label: "Sign in to Tailscale", url: authUrl } : null,
    };
  }
  const serving = parseServeStatus((await run(cli, ["serve", "status", "--json"])).stdout, target);
  return {
    installed: true,
    running: true,
    stopped: false,
    serving,
    url: serving ? `https://${dnsName}` : null,
    detail: null,
    action: null,
  };
}

/** Starts or stops sharing `target` on the tailnet over HTTPS. */
export async function setTailscaleServe(
  plainRun: Run,
  target: string,
  serving: boolean,
  socket = process.env.TAILSCALE_SOCKET,
): Promise<TailscaleState> {
  const run = withSocket(plainRun, socket);
  const cli = await findCli(plainRun);
  if (!cli) return tailscaleState(plainRun, target, socket);
  const args = serving ? ["serve", "--bg", "--https=443", target] : ["serve", "--https=443", "off"];
  const result = await run(cli, args);
  const state = await tailscaleState(plainRun, target, socket);
  if (result.code !== 0 && state.serving !== serving) {
    const output = `${result.stderr}\n${result.stdout}`;
    // A tailnet without Serve turned on says so, with a link to turn it on.
    const enable = /https:\/\/login\.tailscale\.com\/f\/serve\S*/.exec(output)?.[0];
    if (enable) {
      return {
        ...state,
        detail: "Serve isn't turned on for your tailnet yet.",
        action: { label: "Turn on Serve", url: enable },
      };
    }
    const why = output.trim().split("\n")[0] ?? "";
    return { ...state, detail: why ? `tailscale serve failed: ${why}` : "tailscale serve failed" };
  }
  return state;
}

/**
 * Starts `tailscale up` and hands back the link that finishes signing in,
 * for the UI to open. The CLI waits for the sign-in, so it's given a short
 * timeout: the link is printed straight away. A sign-in that's already
 * waiting is reused, and when there's no link the CLI's reason is passed on.
 */
export async function tailscaleLogin(
  plainRun: Run,
  target: string,
  socket = process.env.TAILSCALE_SOCKET,
): Promise<TailscaleState> {
  const run = withSocket(plainRun, socket);
  const before = await tailscaleState(plainRun, target, socket);
  if (!before.installed || before.stopped || before.running || before.action) return before;
  const cli = await findCli(plainRun);
  if (!cli) return before;
  const result = await run(cli, ["up", "--timeout=8s"]);
  const output = `${result.stderr}\n${result.stdout}`;
  const login = /https:\/\/login\.tailscale\.com\/a\/\S+/.exec(output)?.[0];
  const state = await tailscaleState(plainRun, target, socket);
  if (state.running || state.stopped) return state;
  if (login) return { ...state, action: { label: "Sign in to Tailscale", url: login } };
  if (state.action) return state;
  const why = output.trim().split("\n")[0] ?? "";
  return {
    ...state,
    detail: why ? `tailscale up failed: ${why}` : "tailscale up didn't give a sign-in link",
  };
}
