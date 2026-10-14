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
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as dns } from "node:dns";
import { chmod, chown, lstat, mkdir, rename, symlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_GID, AGENT_UID, GUARD_GID, GUARD_ONLY_ENV, GUARD_UID } from "@nibblet/protocol";

const run = promisify(execFile);
const HOME = "/home/nibblet";
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
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

/** The iptables rules, in order: what the agent may reach, then what it may not. */
export function firewallRules(subnet: string | null, allowed: readonly string[]): string[][] {
  const rules: string[][] = [
    // Cloud metadata services (169.254.169.254) hand out a VM's own credentials.
    ["-A", "OUTPUT", "-d", "169.254.0.0/16", "-j", "REJECT"],
  ];
  if (subnet) {
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
  try {
    for (const rule of firewallRules(subnet, allowed)) await run("iptables", rule);
    log(`firewall up (allowing ${allowed.join(", ") || "nothing"} on ${subnet ?? "no subnet"})`);
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
    { stdio: "inherit", env },
  );
}

async function main(): Promise<void> {
  await firewall();
  await folders();

  const guard = as(GUARD_UID, GUARD_GID, [GUARD_GID, AGENT_GID], "guard.ts", {
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
    HOME: GUARD_HOME,
    USER: "guard",
    XDG_RUNTIME_DIR: `/tmp/guard-${GUARD_UID}`,
  });

  // Everything but the guard's secrets. The SSH agent's socket, when it's
  // shared, is root's group on Docker Desktop.
  const runnerEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !GUARD_ONLY_ENV.includes(k)) runnerEnv[k] = v;
  }
  const sshGroup = (await exists("/run/nibblet/ssh-agent.sock")) ? [0] : [];
  const runner = as(AGENT_UID, AGENT_GID, [AGENT_GID, ...sshGroup], "main.ts", {
    ...runnerEnv,
    HOME,
    USER: "nibblet",
  });

  // One stops, both stop: the server sees the container exit and says so.
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of [guard, runner]) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), 3000).unref();
  };
  guard.on("exit", (code) => {
    log(`the guard stopped (${code})`);
    stop(code ?? 1);
  });
  runner.on("exit", (code) => {
    log(`the runner stopped (${code})`);
    stop(code ?? 1);
  });
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`entry: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
