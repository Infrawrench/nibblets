/**
 * The container's first process, run as root just long enough to set things
 * up and split the container into two users:
 *
 * - the guard (GUARD_UID), which holds the secrets: the browser and its
 *   tokens, the gate with its "ask me first" rules, and the MCP servers
 *   behind it (1Password among them) with their settings;
 * - the runner and the agent (AGENT_UID), which only know the gate's address.
 *
 * Neither keeps any capability, and no-new-privileges (set by the server)
 * means nothing regains one. Before they start, a firewall stops the agent
 * reaching the cloud metadata address, or anything on the runners' network
 * but the server and the credential proxy: not other nibblets, not the tunnel.
 *
 * When the nibblet is on the user's tailnet, it also starts Tailscale as a
 * third user (TAILSCALE_UID; see tailscale.ts), and fences in what that user
 * can reach on loopback, which is where whatever comes in from the tailnet
 * is handed over: only the ports the user shared.
 *
 * `entry.ts subagent`, run by the server with `docker exec`, starts a
 * sub-agent's own guard and runner in its parent's container, beside the
 * parent's: the same files, tools and servers, but its own browser (with its
 * own profile), gate, harness state and temporary folder. It shares the
 * parent's desktop (see desktop.ts), as it does its files.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as dns } from "node:dns";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GID,
  AGENT_UID,
  GUARD_GID,
  GUARD_ONLY_ENV,
  GUARD_UID,
  TAILSCALE_GID,
  TAILSCALE_UID,
  TailnetPort,
} from "@nibblet/protocol";
import { TAILSCALE_RUN, TAILSCALE_STATE } from "./tailscale.ts";

const run = promisify(execFile);
const HOME = "/home/nibblet";
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
/** Sub-agents' harness state, and their guards' homes (browser profiles), by id. */
export const SUBAGENT_STATE = path.join(HOME, ".subagents");
const SUBAGENT_GUARD_HOMES = path.join(GUARD_HOME, "subagents");
/** Each running sub-agent's entry's pid, so the server can stop it. */
export const SUBAGENT_PIDS = "/run/nibblet-subagents";
const here = path.dirname(new URL(import.meta.url).pathname);

const log = (message: string) => console.log(`entry: ${message}`);

/** The network this container is on, as `10.89.1.0/24`, from its first non-loopback IPv4 address. */
export function ownSubnet(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.family !== "IPv4" || a.internal || !a.cidr) continue;
      const [ip, bits] = a.cidr.split("/");
      const prefix = Number(bits);
      if (!ip || !Number.isInteger(prefix)) continue;
      const n = ip.split(".").reduce((acc, part) => (acc << 8) | Number(part), 0) >>> 0;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const net = (n & mask) >>> 0;
      return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join(".")}/${prefix}`;
    }
  }
  return null;
}

/** The IPv4 nameservers in a resolv.conf. */
export function nameservers(resolvConf: string): string[] {
  return [...resolvConf.matchAll(/^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]!);
}

/**
 * The iptables rules, in order: what the agent may reach, then what it may
 * not. DNS is let through to the nameservers: Podman's is on the network's
 * gateway, inside the subnet, where Docker's is on loopback.
 */
export function firewallRules(
  subnet: string | null,
  allowed: readonly string[],
  dnsServers: readonly string[] = [],
): string[][] {
  const rules: string[][] = [
    // Cloud metadata services (169.254.169.254) hand out a VM's own credentials.
    ["-A", "OUTPUT", "-d", "169.254.0.0/16", "-j", "REJECT"],
  ];
  if (subnet) {
    for (const ip of dnsServers) {
      for (const proto of ["udp", "tcp"])
        rules.push(["-A", "OUTPUT", "-d", ip, "-p", proto, "--dport", "53", "-j", "ACCEPT"]);
    }
    for (const ip of allowed) rules.push(["-A", "OUTPUT", "-d", ip, "-j", "ACCEPT"]);
    rules.push(["-A", "OUTPUT", "-d", subnet, "-j", "REJECT"]);
  }
  return rules;
}

async function firewall(): Promise<void> {
  const subnet = ownSubnet();
  const allowed: string[] = [];
  for (const host of ["server", "credproxy"]) {
    const found = await dns.lookup(host, { family: 4, all: true }).catch(() => []);
    allowed.push(...found.map((a) => a.address));
  }
  const dnsServers = nameservers(await readFile("/etc/resolv.conf", "utf8").catch(() => ""));
  try {
    for (const rule of firewallRules(subnet, allowed, dnsServers)) await run("iptables", rule);
    log(
      `firewall up (allowing ${allowed.join(", ") || "nothing"}, and DNS to ${dnsServers.join(", ") || "nothing"}, on ${subnet ?? "no subnet"})`,
    );
  } catch (err) {
    // Some engines won't let a container set its own rules; carry on without.
    log(`couldn't set the firewall: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The ports the tailnet may reach, from `NIBBLET_TAILSCALE_PORTS`: only ones a user could have shared. */
export function tailnetPorts(value: string | undefined): number[] {
  return (value ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => TailnetPort.safeParse(p).success);
}

/**
 * What Tailscale's user may reach on loopback: the shared ports and the
 * nameservers (Docker's is on loopback, and its port isn't 53 by the time
 * these rules see it), and nothing else. Whatever comes in from the tailnet
 * is handed to 127.0.0.1 (or ::1) by this user, so this is what the tailnet
 * can reach. The gate, the browser, and the runner's own servers stay out.
 */
export function tailnetRules(
  uid: number,
  ports: readonly number[],
  dnsServers: readonly string[] = [],
): string[][] {
  const mine = ["-A", "OUTPUT", "-o", "lo", "-m", "owner", "--uid-owner", String(uid)];
  return [
    // Replies, on connections it didn't start: the agent's to its proxy.
    [...mine, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ...dnsServers.map((ip) => [...mine, "-d", ip, "-j", "ACCEPT"]),
    ...ports.flatMap((port) =>
      ["tcp", "udp"].map((proto) => [
        ...mine,
        "-p",
        proto,
        "--dport",
        String(port),
        "-j",
        "ACCEPT",
      ]),
    ),
    [...mine, "-j", "REJECT"],
  ];
}

/** Sets the tailnet's rules; says why not when it can't, since Tailscale mustn't start without them. */
async function tailnetFirewall(ports: readonly number[]): Promise<string | null> {
  const dnsServers = nameservers(await readFile("/etc/resolv.conf", "utf8").catch(() => ""));
  try {
    for (const rule of tailnetRules(TAILSCALE_UID, ports, dnsServers)) await run("iptables", rule);
  } catch (err) {
    return `Couldn't fence off the container from the tailnet, so it hasn't joined: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    for (const rule of tailnetRules(TAILSCALE_UID, ports)) await run("ip6tables", rule);
  } catch (err) {
    // Without IPv6 in the container, nothing comes in over it to fence off.
    const ipv6 = (await readFile("/proc/net/if_inet6", "utf8").catch(() => "")).trim();
    if (ipv6) {
      return `Couldn't fence off the container from the tailnet over IPv6, so it hasn't joined: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  log(`tailnet may reach ${ports.length ? `ports ${ports.join(", ")}` : "nothing"}`);
  return null;
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

async function folders(): Promise<void> {
  // The agent's home: its own, but the guard may pass through to the work folder.
  await mkdir(HOME, { recursive: true });
  await chown(HOME, AGENT_UID, AGENT_GID);
  await chmod(HOME, 0o711);

  // The guard's home, on the same volume so the browser's profile is kept.
  if (!(await exists(GUARD_HOME))) await mkdir(GUARD_HOME, { mode: 0o700 });
  const oldProfile = path.join(HOME, ".config", "chromium");
  const newProfile = path.join(GUARD_HOME, ".config", "chromium");
  if ((await exists(oldProfile)) && !(await exists(newProfile))) {
    // From before the guard: the browser's logins move with it.
    await mkdir(path.dirname(newProfile), { recursive: true });
    await rename(oldProfile, newProfile);
  }
  await run("chown", ["-R", `${GUARD_UID}:${GUARD_GID}`, GUARD_HOME]);
  await chmod(GUARD_HOME, 0o700);

  // Downloads: the browser's (the guard's), readable by the agent's group.
  await mkdir(DOWNLOADS, { recursive: true });
  await chown(DOWNLOADS, GUARD_UID, AGENT_GID);
  await chmod(DOWNLOADS, 0o2775);
  const link = path.join(GUARD_HOME, "Downloads");
  if (!(await exists(link))) await symlink(DOWNLOADS, link);
}

const pick = (keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    keys.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] ?? ""]])),
  );

function as(
  uid: number,
  gid: number,
  groups: readonly number[],
  script: string,
  env: Record<string, string>,
  opts: { group?: boolean } = {},
): ChildProcess {
  return spawn(
    "setpriv",
    [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      `--groups=${groups.join(",")}`,
      "--inh-caps=-all",
      "--",
      process.execPath,
      path.join(here, script),
    ],
    // `group`: its own process group, so what it started can be stopped with it.
    { stdio: "inherit", env, detached: opts.group ?? false },
  );
}

interface Pair {
  /** The guard's home: its browser profile and settings. */
  guardHome: string;
  /** Extra environment for both. */
  env: Record<string, string>;
  /** Extra environment for the guard alone. */
  guardEnv: Record<string, string>;
  /** Extra environment for the runner alone. */
  runnerEnv: Record<string, string>;
  /** The guard's runtime folder: a sub-agent's browser has its own display. */
  runtimeDir: string;
}

/** Starts the guard and the runner, and stops both, then this process, when either stops. */
async function startPair(pair: Pair, onStop: () => Promise<void> = async () => {}): Promise<void> {
  const guard = as(
    GUARD_UID,
    GUARD_GID,
    [GUARD_GID, AGENT_GID],
    "guard.ts",
    {
      ...pick([
        "PATH",
        "LANG",
        "TZ",
        "NODE_ENV",
        "CHROME_PATH",
        "OCU_LINUX_DISPLAY",
        "NIBBLET_ID",
        "NIBBLET_SERVER_URL",
        "NIBBLET_BROWSER",
        ...GUARD_ONLY_ENV,
      ]),
      ...pair.env,
      ...pair.guardEnv,
      HOME: pair.guardHome,
      USER: "guard",
      XDG_RUNTIME_DIR: pair.runtimeDir,
    },
    { group: true },
  );

  // Everything but the guard's secrets. The SSH agent's socket, when it's
  // shared, is root's group on Docker Desktop.
  const runnerEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !GUARD_ONLY_ENV.includes(k)) runnerEnv[k] = v;
  }
  const sshGroup = (await exists("/run/nibblet/ssh-agent.sock")) ? [0] : [];
  const runner = as(AGENT_UID, AGENT_GID, [AGENT_GID, ...sshGroup], "main.ts", {
    ...runnerEnv,
    ...pair.env,
    ...pair.runnerEnv,
    HOME,
    USER: "nibblet",
  });

  // One stops, both stop: the server sees the container exit and says so.
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // Also once both have exited and nothing's left to wait for, before the timeout.
    process.exitCode = code;
    for (const child of [guard, runner]) if (child.exitCode === null) child.kill("SIGTERM");
    // Long enough for the runner to give background tasks their SHUTDOWN_GRACE_MS.
    setTimeout(() => void onStop().finally(() => process.exit(code)), 10_000).unref();
  };
  let exited = 0;
  const exit = (name: string) => (code: number | null) => {
    log(`the ${name} stopped (${code})`);
    stop(code ?? 1);
    if (++exited === 2) void onStop();
  };
  guard.on("exit", (code) => {
    // Its browser and MCP servers, which it may not have had the chance to
    // stop: a sub-agent's would outlive it, in a container that carries on.
    try {
      if (guard.pid) process.kill(-guard.pid, "SIGKILL");
    } catch {
      // Nothing left.
    }
    exit("guard")(code);
  });
  runner.on("exit", exit("runner"));
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
}

/** Tailscale's own folders: its state (its own volume) and its control socket's, which only it can open. */
async function tailscaleFolders(): Promise<void> {
  await ownedDir(TAILSCALE_STATE, TAILSCALE_UID, TAILSCALE_GID, 0o700);
  await run("chown", ["-R", `${TAILSCALE_UID}:${TAILSCALE_GID}`, TAILSCALE_STATE]);
  await ownedDir(TAILSCALE_RUN, TAILSCALE_UID, TAILSCALE_GID, 0o700);
}

/**
 * Starts Tailscale, to join, or (`leave`) to sign out the machine a nibblet
 * taken off the tailnet left behind, so its key isn't kept for nothing. It
 * never takes the container down with it: what went wrong goes to the user.
 */
async function startTailscale(leave = false): Promise<ChildProcess | null> {
  const ports = leave ? [] : tailnetPorts(process.env.NIBBLET_TAILSCALE_PORTS);
  let blocked = await tailnetFirewall(ports);
  // Leaving is tidying up: not worth being on the tailnet unfenced for.
  if (leave && blocked) return null;
  if (!blocked) {
    try {
      await tailscaleFolders();
    } catch (err) {
      blocked = `Couldn't set up Tailscale's folders: ${err instanceof Error ? err.message : String(err)}`;
      if (leave) return null;
    }
  }
  const child = as(
    TAILSCALE_UID,
    TAILSCALE_GID,
    [TAILSCALE_GID],
    "tailscale.ts",
    {
      ...pick(["PATH", "LANG", "TZ", "NODE_ENV", "NIBBLET_ID", "NIBBLET_SERVER_URL"]),
      NIBBLET_GUARD_TOKEN: process.env.NIBBLET_GUARD_TOKEN ?? "",
      ...(blocked ? { NIBBLET_TAILSCALE_BLOCKED: blocked } : {}),
      ...(leave ? { NIBBLET_TAILSCALE_LEAVE: "1" } : {}),
      HOME: TAILSCALE_STATE,
      USER: "tailscale",
    },
    { group: true },
  );
  // The nibblet carries on without it: the user sees why on its settings.
  child.on("exit", (code) => log(`tailscale stopped (${code})`));
  child.on("error", (err) => log(`tailscale: ${err.message}`));
  return child;
}

async function main(): Promise<void> {
  await firewall();
  await folders();
  const tailscale = await (
    process.env.NIBBLET_TAILSCALE === "1"
      ? startTailscale()
      : exists(path.join(TAILSCALE_STATE, "tailscaled.state")).then((left) =>
          left ? startTailscale(true) : null,
        )
  ).catch((err: unknown) => {
    log(`couldn't start Tailscale: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  await startPair(
    {
      guardHome: GUARD_HOME,
      env: {},
      guardEnv: {},
      runnerEnv: {},
      runtimeDir: `/tmp/guard-${GUARD_UID}`,
    },
    async () => {
      try {
        if (tailscale?.pid && tailscale.exitCode === null) process.kill(-tailscale.pid, "SIGTERM");
      } catch {
        // Gone.
      }
    },
  );
}

/**
 * Where a sub-agent's ports come from: below Linux's ephemeral range
 * (32768 up), so an outgoing connection can't take one between it being
 * picked here and its server binding it moments later.
 */
export const SUBAGENT_PORTS = { from: 20_000, to: 32_000 };

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** A port in SUBAGENT_PORTS nothing in the container is listening on, nor in `taken`. */
async function freePort(host: string, taken: readonly number[]): Promise<number> {
  const { from, to } = SUBAGENT_PORTS;
  for (let attempt = 0; attempt < 200; attempt++) {
    // At random, so sub-agents starting together don't try the same ones.
    const port = from + Math.floor(Math.random() * (to - from));
    if (!taken.includes(port) && (await canListen(port, host))) return port;
  }
  throw new Error("no free port for the sub-agent");
}

/** Ids are the server's own (`nb_` and base64url), but they end up in paths. */
export function safeId(id: string | undefined): string {
  if (!id || !/^[\w-]+$/.test(id)) throw new Error(`not a nibblet id: ${id}`);
  return id;
}

async function ownedDir(dir: string, uid: number, gid: number, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chown(dir, uid, gid);
  await chmod(dir, mode);
}

/** A sub-agent's guard and runner, in its parent's container (already set up by its entry). */
async function subagent(): Promise<void> {
  const id = safeId(process.env.NIBBLET_ID);
  const pidFile = path.join(SUBAGENT_PIDS, `${id}.pid`);
  // A run of this one that's still going (its server lost track of it) gives way.
  const previous = Number(await readFile(pidFile, "utf8").catch(() => ""));
  if (previous > 0 && previous !== process.pid) {
    try {
      process.kill(previous, "SIGTERM");
      for (let i = 0; i < 60; i++) {
        process.kill(previous, 0);
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {
      // Gone.
    }
  }
  await mkdir(SUBAGENT_PIDS, { recursive: true, mode: 0o700 });
  await writeFile(pidFile, String(process.pid));

  await ownedDir(SUBAGENT_STATE, AGENT_UID, AGENT_GID, 0o700);
  const state = path.join(SUBAGENT_STATE, id);
  await ownedDir(state, AGENT_UID, AGENT_GID, 0o700);
  await ownedDir(SUBAGENT_GUARD_HOMES, GUARD_UID, GUARD_GID, 0o700);
  const guardHome = path.join(SUBAGENT_GUARD_HOMES, id);
  await ownedDir(guardHome, GUARD_UID, GUARD_GID, 0o700);
  const downloads = path.join(guardHome, "Downloads");
  if (!(await exists(downloads))) await symlink(DOWNLOADS, downloads);
  // Its own temporary folder: where harnesses put logins, and the runner its task logs.
  const tmp = `/tmp/nibblet-${id}`;
  await ownedDir(tmp, AGENT_UID, AGENT_GID, 0o700);

  const gate = await freePort("127.0.0.1", []);
  const browser = await freePort("0.0.0.0", [gate]);
  const ports = { gate, browser, view: await freePort("0.0.0.0", [gate, browser]) };
  log(`sub-agent ${id}: gate on ${ports.gate}, browser view on ${ports.view}`);
  await startPair(
    {
      guardHome,
      env: { NIBBLET_GATE_PORT: String(ports.gate), NIBBLET_VIEW_PORT: String(ports.view) },
      guardEnv: { NIBBLET_BROWSER_PORT: String(ports.browser) },
      runnerEnv: { NIBBLET_STATE_DIR: state, TMPDIR: tmp },
      runtimeDir: `/tmp/guard-${GUARD_UID}-${id}`,
    },
    async () => {
      // Only its own: a newer run may have taken the file over.
      if ((await readFile(pidFile, "utf8").catch(() => "")) === String(process.pid))
        await rm(pidFile, { force: true });
    },
  );
}

/** `entry.ts tailscale-leave`: just signs out the machine a nibblet left, in a container of its own. */
async function leaveTailnet(): Promise<void> {
  if (!(await exists(path.join(TAILSCALE_STATE, "tailscaled.state")))) return;
  const child = await startTailscale(true);
  if (child) await new Promise((resolve) => child.once("exit", resolve));
}

const commands: Record<string, () => Promise<void>> = {
  subagent,
  "tailscale-leave": leaveTailnet,
};

if (import.meta.main) {
  (commands[process.argv[2] ?? ""] ?? main)().catch((err: unknown) => {
    console.error(`entry: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
