/**
 * Tailscale for a nibblet's container: it joins the user's tailnet as a
 * machine of its own. The entry runs this as a third user (TAILSCALE_UID),
 * neither the agent nor the guard, after setting a firewall so that what
 * comes in from the tailnet reaches only the ports the user shared.
 *
 * `tailscaled` runs in userspace networking mode, so it needs no device and
 * no capability. Connections from the tailnet are handed to 127.0.0.1 in the
 * container, as this user, which is what the entry's firewall fences in.
 * Going the other way, it serves a SOCKS5 and HTTP proxy on 127.0.0.1 for
 * the agent to reach the tailnet through.
 *
 * Its control socket is in a folder only this user can open, so the agent
 * can't sign it out, share things with `tailscale serve`, or read the key.
 * The key comes from the server, with the guard's token, and goes to
 * `tailscale up` in a file rather than on its command line, which every
 * process in the container can read.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CONTAINER_TAILSCALE_STATE,
  TAILSCALE_PROXY_PORT,
  TAILSCALE_UID,
  TailscaleLogin,
  type TailnetNode,
} from "@nibblet/protocol";
import { z } from "zod";

const exec = promisify(execFile);
const log = (message: string) => console.warn(`tailscale: ${message}`);

/** Its state, on its own volume, so it stays signed in. */
export const TAILSCALE_STATE = CONTAINER_TAILSCALE_STATE;
/** Its control socket and the key on its way to `tailscale up`. */
export const TAILSCALE_RUN = `/tmp/tailscale-${TAILSCALE_UID}`;
const SOCKET = path.join(TAILSCALE_RUN, "tailscaled.sock");
/** Which key it last joined with, so a new one (perhaps for another tailnet) signs in again. */
const KEY_MARK = path.join(TAILSCALE_STATE, "nibblet-auth-key.sha256");
const POLL_MS = 15_000;

export const TailscaleEnv = z.object({
  NIBBLET_ID: z.string(),
  NIBBLET_SERVER_URL: z.string(),
  NIBBLET_GUARD_TOKEN: z.string(),
  /** Set by the entry when it couldn't fence the tailnet in: why, for the user. */
  NIBBLET_TAILSCALE_BLOCKED: z.string().optional(),
  /** Set when the nibblet was taken off the tailnet: sign out and forget the machine. */
  NIBBLET_TAILSCALE_LEAVE: z.literal("1").optional(),
});
export type TailscaleEnv = z.infer<typeof TailscaleEnv>;

const node = (state: TailnetNode["state"], detail: string | null = null): TailnetNode => ({
  state,
  dnsName: null,
  ips: [],
  tailnet: null,
  detail,
});

/** Talking to the server, with the guard's token. */
export function tailscaleClient(env: TailscaleEnv, fetcher: typeof fetch = fetch) {
  const auth = { authorization: `Bearer ${env.NIBBLET_GUARD_TOKEN}` };
  const url = `${env.NIBBLET_SERVER_URL}/guard/${encodeURIComponent(env.NIBBLET_ID)}/tailscale`;
  return {
    async login(): Promise<TailscaleLogin> {
      const res = await fetcher(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
      return TailscaleLogin.parse(await res.json());
    },
    async report(state: TailnetNode): Promise<void> {
      const res = await fetcher(url, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
    },
  };
}

const Status = z.looseObject({
  BackendState: z.string(),
  Self: z
    .looseObject({
      DNSName: z.string().optional(),
      TailscaleIPs: z.array(z.string()).nullish(),
    })
    .nullish(),
  CurrentTailnet: z.looseObject({ Name: z.string().optional() }).nullish(),
});

/** Its machine, from `tailscale status --json`. */
export function nodeFromStatus(text: string): TailnetNode {
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not up yet.
  }
  const parsed = Status.safeParse(json);
  if (!parsed.success) return node("starting");
  const { BackendState, Self, CurrentTailnet } = parsed.data;
  switch (BackendState) {
    case "Running":
      return {
        state: "running",
        dnsName: Self?.DNSName?.replace(/\.$/, "") || null,
        ips: Self?.TailscaleIPs ?? [],
        tailnet: CurrentTailnet?.Name || null,
        detail: null,
      };
    case "NeedsLogin":
      return node(
        "needs_login",
        "Its auth key didn't work: it may have expired, or been used already. Paste a new one.",
      );
    case "NeedsMachineAuth":
      return node("needs_login", "Approve it in the Tailscale admin console.");
    default:
      return node("starting");
  }
}

/** The first line of what a failed `tailscale` command said. */
export function why(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim() || e.message || String(err);
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "it failed"
  );
}

const tailscale = async (args: string[], timeout = 30_000) =>
  (await exec("tailscale", [`--socket=${SOCKET}`, ...args], { timeout })).stdout;

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

async function waitForSocket(daemon: { exited: boolean }): Promise<void> {
  for (let i = 0; i < 100 && !daemon.exited; i++) {
    if (await exists(SOCKET)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("tailscaled didn't start");
}

/** Starts `tailscaled`, keeping the end of what it says for when it stops. */
function startDaemon(): { child: ChildProcess; exited: boolean; tail: string } {
  const child = spawn(
    "tailscaled",
    [
      "--tun=userspace-networking",
      `--statedir=${TAILSCALE_STATE}`,
      `--socket=${SOCKET}`,
      `--socks5-server=127.0.0.1:${TAILSCALE_PROXY_PORT}`,
      `--outbound-http-proxy-listen=127.0.0.1:${TAILSCALE_PROXY_PORT}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const daemon = { child, exited: false, tail: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    daemon.tail = (daemon.tail + chunk.toString("utf8")).slice(-2000);
  });
  child.once("exit", () => {
    daemon.exited = true;
  });
  child.once("error", (err) => {
    daemon.exited = true;
    daemon.tail += `\n${err.message}`;
  });
  return daemon;
}

/** Joins with the key, or with the machine it already is when the key hasn't changed. */
async function up(login: TailscaleLogin): Promise<void> {
  const mark = createHash("sha256").update(login.authKey).digest("hex");
  const previous = await readFile(KEY_MARK, "utf8").catch(() => null);
  if (previous !== null && previous.trim() !== mark) {
    log("the auth key changed; signing in again");
    await tailscale(["logout"]).catch((err: unknown) => log(`logout: ${why(err)}`));
  }
  const keyFile = path.join(TAILSCALE_RUN, "authkey");
  await writeFile(keyFile, login.authKey, { mode: 0o600 });
  try {
    await tailscale(
      [
        "up",
        "--reset",
        `--auth-key=file:${keyFile}`,
        `--hostname=${login.hostname}`,
        "--timeout=60s",
      ],
      90_000,
    );
  } finally {
    await rm(keyFile, { force: true });
  }
  await writeFile(KEY_MARK, mark);
}

/** Signs the machine out of the tailnet, and forgets it. */
async function leave(): Promise<void> {
  await mkdir(TAILSCALE_RUN, { recursive: true, mode: 0o700 });
  const daemon = startDaemon();
  try {
    await waitForSocket(daemon);
    await tailscale(["logout"]);
    log("signed out of the tailnet");
  } catch (err) {
    log(`couldn't sign out: ${why(err)}`);
  } finally {
    daemon.child.kill("SIGTERM");
  }
  // The folder is the volume's, so it stays, empty.
  for (const entry of await readdir(TAILSCALE_STATE).catch(() => []))
    await rm(path.join(TAILSCALE_STATE, entry), { recursive: true, force: true });
}

async function main(): Promise<void> {
  const env = TailscaleEnv.parse(process.env);
  if (env.NIBBLET_TAILSCALE_LEAVE) return leave();
  const server = tailscaleClient(env);
  const report = (state: TailnetNode) =>
    server.report(state).catch((err: unknown) => log(`couldn't report: ${why(err)}`));
  if (env.NIBBLET_TAILSCALE_BLOCKED) {
    log(env.NIBBLET_TAILSCALE_BLOCKED);
    await report(node("error", env.NIBBLET_TAILSCALE_BLOCKED));
    return;
  }

  let login: TailscaleLogin | null = null;
  for (let attempt = 1; !login; attempt++) {
    try {
      login = await server.login();
    } catch (err) {
      if (attempt >= 30) throw err;
      log(`waiting for the server: ${why(err)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await mkdir(TAILSCALE_RUN, { recursive: true, mode: 0o700 });

  let daemon = startDaemon();
  let stopping = false;
  const shutdown = () => {
    stopping = true;
    daemon.child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Why joining failed, which says more than "needs login" does.
  let failed: string | null = null;
  let reported = "";
  try {
    await waitForSocket(daemon);
    await up(login);
  } catch (err) {
    failed = daemon.exited
      ? `tailscaled stopped: ${why({ stdout: daemon.tail.split("\n").slice(-3).join("\n") })}`
      : `Couldn't join: ${why(err)}`;
    log(failed);
    await report(node("error", failed));
    reported = JSON.stringify(node("error", failed));
  }

  // From here it keeps the server told, and brings tailscaled back if it stops:
  // with its state on disk, it rejoins as the same machine by itself.

  for (let restarts = 0; !stopping;) {
    if (daemon.exited) {
      if (++restarts > 5) {
        await report(node("error", "tailscaled keeps stopping"));
        return;
      }
      log(`tailscaled stopped; starting it again: ${daemon.tail.split("\n").slice(-2).join(" ")}`);
      daemon = startDaemon();
      await waitForSocket(daemon).catch(() => undefined);
    }
    let state = await tailscale(["status", "--json"]).then(nodeFromStatus, () => null);
    if (state?.state === "running") failed = null;
    else if (state && failed) state = node("error", failed);
    if (state && JSON.stringify(state) !== reported) {
      reported = JSON.stringify(state);
      if (state.state === "running") log(`on the tailnet as ${state.dnsName ?? state.ips[0]}`);
      await report(state);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`tailscale: ${why(err)}`);
    process.exit(1);
  });
}
