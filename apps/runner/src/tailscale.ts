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
 *
 * On Windows it's the same, but for who it runs as. tailscaled's pipe is
 * open to every user, so it's kept by owning it: tailscaled runs as SYSTEM,
 * and `tailscale` as a user of its own (TAILSCALE_USER), whose `up
 * --unattended` makes it tailscaled's owner, which only SYSTEM and it may
 * then talk to. The pipe is where only an administrator can make one, so
 * nothing can pose as tailscaled for the key. The entry fences tailscaled
 * in with nibblet-fence (machine/windows/fence.cs) rather than a firewall.
 *
 * On macOS it's as on Linux, with tailscaled built from source by the
 * image's bootstrap, its state on the system disk, and pf fencing in what
 * its user may reach on loopback.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  CONTAINER_TAILSCALE_STATE,
  TAILSCALE_PROXY_PORT,
  TAILSCALE_UID,
  TailscaleAuthKey,
  TailscaleLogin,
  type TailnetNode,
} from "@nibblets/protocol";
import { z } from "zod";

const exec = promisify(execFile);
const log = (message: string) => console.warn(`tailscale: ${message}`);

/** Its state, on its own volume, so it stays signed in. */
export const TAILSCALE_STATE = CONTAINER_TAILSCALE_STATE;
/** Its control socket and the key on its way to `tailscale up`. */
export const TAILSCALE_RUN = `/tmp/tailscale-${TAILSCALE_UID}`;

/** Windows' Tailscale: its binaries, from the image's bootstrap, and its state on the system disk. */
export const WINDOWS_TAILSCALE = {
  dir: "C:\\Nibblets\\tailscale",
  tailscaled: "C:\\Nibblets\\tailscale\\tailscaled.exe",
  state: "C:\\ProgramData\\Nibblets\\tailscale",
  run: "C:\\ProgramData\\Nibblets\\tailscale-run",
};
/** macOS's Tailscale: built by the image's bootstrap, with its state on the system disk. */
export const MACOS_TAILSCALE = {
  dir: "/Library/Nibblets/tailscale",
  tailscaled: "/Library/Nibblets/tailscale/tailscaled",
  state: "/private/var/db/nibblets-tailscale",
  run: TAILSCALE_RUN,
};
/** Windows' user for `tailscale`, which owns tailscaled. */
export const TAILSCALE_USER = "nibblet-tailscale";

/** Where Tailscale is, and how its CLI's run, on this machine. */
interface TailscaleHost {
  state: string;
  run: string;
  socket: string;
  tailscaled: string;
  cli: { command: string; args: readonly string[] };
  /** What `up` adds, to keep it signed in as whoever ran it. */
  up: readonly string[];
}

export function tailscaleHost(platform: NodeJS.Platform): TailscaleHost {
  if (platform === "win32") {
    const w = WINDOWS_TAILSCALE;
    return {
      state: w.state,
      run: w.run,
      socket: "\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Nibblets\\tailscaled",
      tailscaled: w.tailscaled,
      cli: {
        command: "C:\\Nibblets\\bin\\nibblet-runas.exe",
        args: [TAILSCALE_USER, path.win32.join(w.dir, "tailscale.exe")],
      },
      up: ["--unattended"],
    };
  }
  if (platform === "darwin") {
    const m = MACOS_TAILSCALE;
    return {
      state: m.state,
      run: m.run,
      socket: path.join(m.run, "tailscaled.sock"),
      tailscaled: m.tailscaled,
      cli: { command: path.join(m.dir, "tailscale"), args: [] },
      up: [],
    };
  }
  return {
    state: TAILSCALE_STATE,
    run: TAILSCALE_RUN,
    socket: path.join(TAILSCALE_RUN, "tailscaled.sock"),
    tailscaled: "tailscaled",
    cli: { command: "tailscale", args: [] },
    up: [],
  };
}

const HOST = tailscaleHost(process.platform);
const SOCKET = HOST.socket;
/** Which key it last joined with, so a new one (perhaps for another tailnet) signs in again. */
const KEY_MARK = path.join(HOST.state, "nibblet-auth-key.sha256");
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

type TailscaleClient = ReturnType<typeof tailscaleClient>;

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
    /** A key to sign in with: its own, or one the server makes. */
    async authKey(): Promise<string> {
      const res = await fetcher(`${url}/key`, {
        method: "POST",
        headers: auth,
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `the server said ${res.status}`);
      return TailscaleAuthKey.parse(body).authKey;
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not up yet.
    return null;
  }
}

/** Its machine, from `tailscale status --json`. */
export function nodeFromStatus(text: string): TailnetNode {
  const parsed = Status.safeParse(parseJson(text));
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
  (
    await exec(HOST.cli.command, [...HOST.cli.args, `--socket=${SOCKET}`, ...args], {
      timeout,
      windowsHide: true,
    })
  ).stdout;

/** Whether tailscaled is listening: its socket, or on Windows its pipe, takes a connection. */
const listening = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect(SOCKET);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

async function waitForSocket(daemon: { exited: boolean }): Promise<void> {
  for (let i = 0; i < 100 && !daemon.exited; i++) {
    if (await listening()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("tailscaled didn't start");
}

/** Starts `tailscaled`, keeping the end of what it says for when it stops. */
function startDaemon(): { child: ChildProcess; exited: boolean; tail: string } {
  const child = spawn(
    HOST.tailscaled,
    [
      "--tun=userspace-networking",
      `--statedir=${HOST.state}`,
      `--socket=${SOCKET}`,
      `--socks5-server=127.0.0.1:${TAILSCALE_PROXY_PORT}`,
      `--outbound-http-proxy-listen=127.0.0.1:${TAILSCALE_PROXY_PORT}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
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

/** Where tailscaled has got to, once it's read its state: `Running`, `NeedsLogin` and so on. */
async function backendState(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const text = await tailscale(["status", "--json"]).catch(() => "");
    const state = Status.safeParse(parseJson(text)).data?.BackendState;
    if (state && state !== "NoState") return state;
    await new Promise((r) => setTimeout(r, 200));
  }
  return "NoState";
}

/**
 * Joins, or carries on as the machine it already is. A key is asked for only
 * when it has to sign in, since the server may make one each time it's asked.
 * A change of key (perhaps to another tailnet) signs out first.
 */
async function up(login: TailscaleLogin, server: TailscaleClient): Promise<void> {
  const previous = (await readFile(KEY_MARK, "utf8").catch(() => null))?.trim() ?? null;
  if (login.keyId && previous && previous !== login.keyId) {
    log("its auth key changed; signing in again");
    await tailscale(["logout"]).catch((err: unknown) => log(`logout: ${why(err)}`));
  }
  const state = await backendState();
  if (state === "Running" || state === "Starting") {
    // In already: `up --reset` could undo what its key set, like its tags.
    await tailscale(["set", `--hostname=${login.hostname}`]);
  } else if (state === "NeedsMachineAuth") {
    // Signed in, waiting on the tailnet's admin to approve it.
  } else {
    const keyFile = path.join(HOST.run, "authkey");
    const args = ["up", "--reset", ...HOST.up, `--hostname=${login.hostname}`, "--timeout=60s"];
    if (state === "NeedsLogin" || state === "NoState") {
      await writeFile(keyFile, await server.authKey(), { mode: 0o600 });
      args.push(`--auth-key=file:${keyFile}`);
    }
    try {
      await tailscale(args, 90_000);
    } finally {
      await rm(keyFile, { force: true });
    }
  }
  if (login.keyId) await writeFile(KEY_MARK, login.keyId);
}

/** Signs the machine out of the tailnet, and forgets it. */
async function leave(): Promise<void> {
  await mkdir(HOST.run, { recursive: true, mode: 0o700 });
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
  for (const entry of await readdir(HOST.state).catch(() => []))
    await rm(path.join(HOST.state, entry), { recursive: true, force: true });
}

async function main(): Promise<void> {
  // Run with nothing else (see the server's leaveTailnet), so before the rest is asked for.
  if (process.env.NIBBLET_TAILSCALE_LEAVE) return leave();
  const env = TailscaleEnv.parse(process.env);
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
  await mkdir(HOST.run, { recursive: true, mode: 0o700 });

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
    await up(login, server);
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
      // Five in a row, not five in the life of the container.
      if (++restarts > 5) {
        await report(node("error", "tailscaled keeps stopping"));
        return;
      }
      log(`tailscaled stopped; starting it again: ${daemon.tail.split("\n").slice(-2).join(" ")}`);
      daemon = startDaemon();
      await waitForSocket(daemon).catch(() => undefined);
    }
    const text = await tailscale(["status", "--json"]).catch(() => null);
    let state = text === null ? null : nodeFromStatus(text);
    if (state) restarts = 0;
    if (state?.state === "running") failed = null;
    // Waiting for the admin's approval says more than the timeout it led to.
    else if (state && failed && !text?.includes('"NeedsMachineAuth"'))
      state = node("error", failed);
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
