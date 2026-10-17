/**
 * Linux, in a container or a VM: iptables for the firewall, setpriv for
 * running as the guard and the agent (with no capabilities), and Tailscale
 * as a third user, fenced in, for a nibblet on a tailnet. See entry.ts.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as dns } from "node:dns";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GID,
  AGENT_UID,
  GUARD_GID,
  GUARD_UID,
  HOME_ARCHIVE_EXCLUDES,
  TAILSCALE_GID,
  TAILSCALE_UID,
  TailnetPort,
} from "@nibblet/protocol";
import { TAILSCALE_RUN, TAILSCALE_STATE } from "../tailscale.ts";
import { inherit, pick, sleep } from "./shared.ts";
import type { EntryPlatform, Who } from "./platform.ts";

const run = promisify(execFile);
const HOME = "/home/nibblet";
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
const scripts = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

const log = (message: string) => console.log(`entry: ${message}`);
/** Set by the guest agent: this is a VM, not a container. */
const IN_VM = process.env.NIBBLET_IN_VM === "1";
/** Where a VM's home disk is mounted (machine/linux.ts), which holds the home folder. */
const VM_DATA = "/var/lib/nibblet-data";

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
  // The host too: a container's is outside its subnet anyway, but a VM's is
  // its gateway, inside it, and OpenCode's local providers (Ollama) are there.
  for (const host of ["server", "credproxy", "host.docker.internal"]) {
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

/** Runs one of the runner's scripts as a user with no capabilities. */
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
      // Nothing it runs (a setuid binary) can gain a privilege back. A
      // container has both of these from Docker already, and can't change
      // its bounding set (no CAP_SETPCAP); a VM has neither until now.
      ...(IN_VM ? ["--no-new-privs", "--bounding-set=-all"] : []),
      "--",
      process.execPath,
      path.join(scripts, script),
    ],
    // `group`: its own process group, so what it started can be stopped with it.
    { stdio: "inherit", env, detached: opts.group ?? false },
  );
}

async function ownedDir(dir: string, uid: number, gid: number, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chown(dir, uid, gid);
  await chmod(dir, mode);
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

/** `entry.ts tailscale-leave`: just signs out the machine a nibblet left, in a container of its own. */
async function leaveTailnet(): Promise<void> {
  if (!(await exists(path.join(TAILSCALE_STATE, "tailscaled.state")))) return;
  const child = await startTailscale(true);
  if (child) await new Promise((resolve) => child.once("exit", resolve));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const linux: EntryPlatform = {
  home: HOME,
  pids: "/run/nibblet-subagents",
  guardEnv: ["PATH", "LANG", "TZ", "NODE_ENV", "CHROME_PATH", "OCU_LINUX_DISPLAY"],

  async prepare() {
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
    return async () => {
      try {
        if (tailscale?.pid && tailscale.exitCode === null) process.kill(-tailscale.pid, "SIGTERM");
      } catch {
        // Gone.
      }
    };
  },

  ownedDir(dir, who: Who, mode) {
    return who === "guard"
      ? ownedDir(dir, GUARD_UID, GUARD_GID, mode)
      : ownedDir(dir, AGENT_UID, AGENT_GID, mode);
  },

  async link(to, at) {
    if (!(await exists(at))) await symlink(to, at);
  },

  tmpDir: (id) => `/tmp/nibblet-${id}`,
  runtimeDir: (id) => (id ? `/tmp/guard-${GUARD_UID}-${id}` : `/tmp/guard-${GUARD_UID}`),

  spawn(who, script, env, opts) {
    if (who === "guard") return as(GUARD_UID, GUARD_GID, [GUARD_GID, AGENT_GID], script, env, opts);
    // The SSH agent's socket, when it's shared, is root's group on Docker Desktop.
    const sshGroup = existsSync("/run/nibblet/ssh-agent.sock") ? [0] : [];
    return as(AGENT_UID, AGENT_GID, [AGENT_GID, ...sshGroup], script, env, opts);
  },

  killTree(child) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Nothing left.
    }
  },

  async terminate(pid, graceMs) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let waited = 0; waited < graceMs && alive(pid); waited += 250) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  },

  async archiveHome() {
    // Held still while it's copied, as a paused container is: in a VM, its
    // home disk is frozen, so writes wait and nothing's caught half-written.
    const frozen =
      IN_VM &&
      (await run("fsfreeze", ["-f", VM_DATA]).then(
        () => true,
        () => false,
      ));
    try {
      await inherit("tar", [
        "-C",
        path.dirname(HOME),
        "-czf",
        "-",
        ...HOME_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`),
        path.basename(HOME),
      ]);
    } finally {
      if (frozen) await run("fsfreeze", ["-u", VM_DATA]).catch(() => undefined);
    }
  },

  restoreHome: () =>
    inherit("sh", [
      "-c",
      `find ${HOME} -mindepth 1 -delete && tar -C ${path.dirname(HOME)} -xzpf -`,
    ]),

  leaveTailnet,
};
