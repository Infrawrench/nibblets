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
 * `entry.ts subagent`, run by the server with `docker exec`, starts a
 * sub-agent's own guard and runner in its parent's container, beside the
 * parent's: the same files, tools and servers, but its own browser (with its
 * own profile), gate, harness state and temporary folder.
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
import { AGENT_GID, AGENT_UID, GUARD_GID, GUARD_ONLY_ENV, GUARD_UID } from "@nibblet/protocol";

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

async function main(): Promise<void> {
  await firewall();
  await folders();
  await startPair({
    guardHome: GUARD_HOME,
    env: {},
    guardEnv: {},
    runnerEnv: {},
    runtimeDir: `/tmp/guard-${GUARD_UID}`,
  });
}

/** A port nothing in the container is listening on, for now. */
function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
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

  const ports = {
    gate: await freePort("127.0.0.1"),
    browser: await freePort("0.0.0.0"),
    view: await freePort("0.0.0.0"),
  };
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

if (import.meta.main) {
  (process.argv[2] === "subagent" ? subagent() : main()).catch((err: unknown) => {
    console.error(`entry: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
