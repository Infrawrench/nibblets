/**
 * macOS, in a VM: three hidden users made with dscl (the agent, the guard,
 * and Tailscale's), each started with Node's own uid and gid; folders as on
 * Linux; and pf for the firewall, in an anchor under the com.apple one the
 * stock rules already load, so nothing of the system's is touched.
 *
 * The agent's user is signed in to the desktop at boot, as Windows' is
 * (machine/macos-desktop.ts): the browser (Google Chrome) and the
 * desktop's apps are OpenComputerUse's, run as that user in that session.
 * The guard starts its OpenComputerUse through sudo, which may run only
 * the session script (SESSION_SCRIPT) for it, with its two tokens.
 *
 * Tailscale's tailscaled, built by the image's bootstrap, runs as its own
 * user in userspace networking, as on Linux, with pf fencing in what that
 * user may reach on loopback.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_GID,
  AGENT_UID,
  GUARD_GID,
  GUARD_UID,
  HOME_ARCHIVE_EXCLUDES,
  TAILSCALE_GID,
  TAILSCALE_UID,
} from "@nibblets/protocol";
import { users, waitForDesktop } from "../machine/macos-desktop.ts";
import { MACOS_TAILSCALE } from "../tailscale.ts";
import { ownSubnet, tailnetPorts } from "./linux.ts";
import { inherit, pick, sleep } from "./shared.ts";
import type { EntryPlatform } from "./platform.ts";

const run = promisify(execFile);
const HOME = "/Users/nibblet";
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
/** Chrome's profile, as the image's policies for it say, where Edge's is on Windows. */
const BROWSER_PROFILE = path.join(HOME, ".browser");
const scripts = fileURLToPath(new URL("..", import.meta.url));
/** Where the rules go: the stock pf.conf loads every anchor under com.apple. */
export const PF_ANCHOR = "com.apple/250.Nibblets";
/** The image's own files (machine-apple's provision.ts). */
const NIBBLETS = "/Library/Nibblets";
/** OpenComputerUse, which the image's bootstrap installs, and which holds the desktop's permissions. */
export const OCU_APP = "/Applications/OpenComputerUse.app";
/** Starts OpenComputerUse in the agent's desktop session, as the agent's user. */
export const SESSION_SCRIPT = path.join(NIBBLETS, "bin", "nibblet-session");
const SUDOERS = "/private/etc/sudoers.d/nibblets";
/** The host's VM helper, put in the image, which runs a program answering for itself to TCC. */
const DISCLAIM = `${path.join(NIBBLETS, "bin", "nibblet-vm")} disclaim`;

const log = (message: string) => console.log(`entry: ${message}`);

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** What the tailnet may reach: Tailscale's user, on loopback, and the ports shared. */
export interface TailnetFence {
  uid: number;
  ports: readonly number[];
}

/**
 * pf's rules: what the agent may reach on its VM's network (the host, its
 * DNS), then what it may not; and, for a nibblet on a tailnet, what
 * Tailscale's user may reach on loopback, which is what the tailnet can
 * reach. pf keeps no state for traffic no rule passes, so everyone else's
 * on loopback is passed with state, for tailscaled's replies to the agent's
 * connections to its proxy to be let through.
 */
export function pfRules(
  subnet: string | null,
  gateway: string | null,
  tailnet: TailnetFence | null = null,
): string {
  return [
    // Cloud metadata services hand out a VM's own credentials.
    "block drop out quick inet from any to 169.254.0.0/16",
    ...(subnet
      ? [
          ...(gateway ? [`pass out quick inet from any to ${gateway}`] : []),
          `block drop out quick inet from any to ${subnet}`,
        ]
      : []),
    ...(tailnet
      ? [
          `pass out quick on lo0 proto { tcp udp } all user != ${tailnet.uid} keep state`,
          ...tailnet.ports.map(
            (port) =>
              `pass out quick on lo0 proto { tcp udp } to any port ${port} user ${tailnet.uid} keep state`,
          ),
          `block return out quick on lo0 proto { tcp udp } all user ${tailnet.uid}`,
        ]
      : []),
    "",
  ].join("\n");
}

/** Loads the anchor's rules; throws when pf won't have them. */
async function loadRules(rules: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pfctl", ["-a", PF_ANCHOR, "-f", "-"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let said = "";
    child.stderr.on("data", (c: Buffer) => (said += c.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(said.trim() || `pfctl exited ${code}`)),
    );
    child.stdin.end(rules);
  });
  // On, whether it was or not; pf counts who asked, so this never turns off anyone else's.
  await run("pfctl", ["-E"]).catch(() => undefined);
}

/**
 * The firewall, with the tailnet's fence when Tailscale's to run. Without
 * the fence, Tailscale doesn't join, and the user's told why (the reason's
 * returned); the rest of the firewall the nibblet carries on without.
 */
async function firewall(tailnet: TailnetFence | null): Promise<string | null> {
  const subnet = ownSubnet();
  const gateway = await run("route", ["-n", "get", "default"]).then(
    (r) => /gateway:\s*(\S+)/.exec(r.stdout)?.[1] ?? null,
    () => null,
  );
  try {
    await loadRules(pfRules(subnet, gateway, tailnet));
    log(`firewall up (allowing ${gateway ?? "nothing"} on ${subnet ?? "no subnet"})`);
    if (tailnet) {
      const ports = tailnet.ports;
      log(`tailnet may reach ${ports.length ? `ports ${ports.join(", ")}` : "nothing"}`);
    }
    return null;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`couldn't set the firewall: ${why}`);
    if (!tailnet) return null;
    // Without the tailnet's fence, at least the rest.
    await loadRules(pfRules(subnet, gateway)).catch(() => undefined);
    return `Couldn't fence off the machine from the tailnet, so it hasn't joined: ${why}`;
  }
}

async function ownedDir(dir: string, uid: number, gid: number, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chown(dir, uid, gid);
  await chmod(dir, mode);
}

async function folders(): Promise<void> {
  await mkdir(path.join(HOME, "work"), { recursive: true });
  await run("chown", ["-R", `${AGENT_UID}:${AGENT_GID}`, path.join(HOME, "work")]);
  await ownedDir(HOME, AGENT_UID, AGENT_GID, 0o711);
  if (!(await exists(GUARD_HOME))) await mkdir(GUARD_HOME, { mode: 0o700 });
  await run("chown", ["-R", `${GUARD_UID}:${GUARD_GID}`, GUARD_HOME]);
  await chmod(GUARD_HOME, 0o700);
  await mkdir(DOWNLOADS, { recursive: true });
  await chown(DOWNLOADS, GUARD_UID, AGENT_GID);
  await chmod(DOWNLOADS, 0o2775);
  const link = path.join(GUARD_HOME, "Downloads");
  if (!(await exists(link))) await symlink(DOWNLOADS, link);
  // Chrome's profile (its policies put it here), past its first run's questions.
  await ownedDir(BROWSER_PROFILE, AGENT_UID, AGENT_GID, 0o700);
  const firstRun = path.join(BROWSER_PROFILE, "First Run");
  if (!(await exists(firstRun))) {
    await writeFile(firstRun, "");
    await chown(firstRun, AGENT_UID, AGENT_GID);
  }
}

/**
 * The session script, and what lets the guard run it: as root, through
 * sudo, which hands on only OpenComputerUse's two tokens. It starts
 * OpenComputerUse in the agent's desktop session (launchctl asuser), as
 * the agent's user, with nothing else of its caller's, and answering for
 * itself to macOS's privacy checks (the image's helper's disclaim): they'd
 * be of the guest agent's Node otherwise, which hasn't its permissions.
 */
export const SESSION_SH = `#!/bin/sh
set -eu
uid=$(/usr/bin/id -u nibblet)
cd /Users/nibblet/work
exec ${DISCLAIM} /bin/launchctl asuser "$uid" /usr/bin/sudo -n -H -u nibblet \\
  --preserve-env=OCU_SERVE_TOKEN,OCU_VIEW_TOKEN \\
  ${OCU_APP}/Contents/MacOS/opencomputeruse "$@"
`;

export const SUDOERS_RULES = `Defaults!${SESSION_SCRIPT} env_keep += "OCU_SERVE_TOKEN OCU_VIEW_TOKEN"
_nibbletguard ALL = (root) NOPASSWD: ${SESSION_SCRIPT}
`;

async function sessionScript(): Promise<void> {
  await mkdir(path.dirname(SESSION_SCRIPT), { recursive: true });
  await writeFile(SESSION_SCRIPT, SESSION_SH, { mode: 0o755 });
  await chown(SESSION_SCRIPT, 0, 0);
  await chmod(SESSION_SCRIPT, 0o755);
  await writeFile(`${SUDOERS}.new`, SUDOERS_RULES, { mode: 0o440 });
  // A sudoers file that doesn't parse would break sudo for everyone.
  await run("visudo", ["-c", "-f", `${SUDOERS}.new`]);
  await run("mv", ["-f", `${SUDOERS}.new`, SUDOERS]);
}

/** Tailscale's folders: its state, its own alone, and its control socket's, which only it can open. */
async function tailscaleFolders(): Promise<void> {
  await ownedDir(MACOS_TAILSCALE.state, TAILSCALE_UID, TAILSCALE_GID, 0o700);
  await run("chown", ["-R", `${TAILSCALE_UID}:${TAILSCALE_GID}`, MACOS_TAILSCALE.state]);
  await ownedDir(MACOS_TAILSCALE.run, TAILSCALE_UID, TAILSCALE_GID, 0o700);
}

/**
 * Starts Tailscale, to join, or (`leave`) to sign out the machine a
 * nibblet taken off the tailnet left behind. `blocked` is why it can't
 * join, if it can't: it starts anyway, to tell the user.
 */
function startTailscale(blocked: string | null, leave = false): ChildProcess | null {
  if (!existsSync(MACOS_TAILSCALE.tailscaled)) {
    log("there's no Tailscale in this machine's image");
    return null;
  }
  const child = spawn(process.execPath, [path.join(scripts, "tailscale.ts")], {
    uid: TAILSCALE_UID,
    gid: TAILSCALE_GID,
    env: {
      ...pick(["PATH", "LANG", "TZ", "NODE_ENV", "NIBBLET_ID", "NIBBLET_SERVER_URL"]),
      NIBBLET_GUARD_TOKEN: process.env.NIBBLET_GUARD_TOKEN ?? "",
      ...(blocked ? { NIBBLET_TAILSCALE_BLOCKED: blocked } : {}),
      ...(leave ? { NIBBLET_TAILSCALE_LEAVE: "1" } : {}),
      HOME: MACOS_TAILSCALE.state,
      USER: "_nibblettailscale",
    },
    stdio: "inherit",
    detached: true,
  });
  // The nibblet carries on without it: the user sees why on its settings.
  child.on("exit", (code) => log(`tailscale stopped (${code})`));
  child.on("error", (err) => log(`tailscale: ${err.message}`));
  return child;
}

const tailscaleLeft = () => existsSync(path.join(MACOS_TAILSCALE.state, "tailscaled.state"));

/** `entry.ts tailscale-leave`: just signs out the machine a nibblet left. */
async function leaveTailnet(): Promise<void> {
  if (!tailscaleLeft()) return;
  // Leaving is tidying up: not worth being on the tailnet unfenced for.
  if (await firewall({ uid: TAILSCALE_UID, ports: [] })) return;
  await tailscaleFolders();
  const child = startTailscale(null, true);
  if (child) await new Promise((resolve) => child.once("exit", resolve));
}

/**
 * The home is a volume of its own, mounted over the home folder, so macOS's
 * folders for the volume (Spotlight's, its events', its trash) are in it.
 * They're the system's, which root can't always even read: never archived,
 * and left where they are.
 */
export const VOLUME_FOLDERS = [
  ".Spotlight-V100",
  ".fseventsd",
  ".Trashes",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
];

/**
 * What tar says of a file macOS won't let even root read or change, Full
 * Disk Access and all (the system's own caches, in a signed-in user's
 * Library), and of its having carried on past one. Root gets "Operation
 * not permitted" from nothing else.
 */
const FENCED = /: Operation not permitted$/;
const CARRIED_ON = /^tar: Error exit delayed from previous errors\.$/;

/** Whether tar's complaints were only of files macOS fences off, which a home does without. */
export function onlyFenced(said: readonly string[]): boolean {
  const errors = said.filter((line) => line.trim() && !CARRIED_ON.test(line));
  return errors.length > 0 && errors.every((line) => FENCED.test(line));
}

/**
 * tar, with what it says passed on, carrying on past what macOS fences off:
 * those are the system's files (Apple's model caches, say), not the agent's.
 */
function fencedTar(args: string[], stdio: "in" | "out"): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", args, {
      stdio: stdio === "out" ? ["ignore", "inherit", "pipe"] : ["inherit", "ignore", "pipe"],
    });
    let said = "";
    tar.stderr?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    tar.once("error", reject);
    tar.once("close", (code) => {
      if (code === 0) return resolve();
      const lines = said.split("\n");
      if (code === 1 && onlyFenced(lines)) {
        const fenced = lines.filter((line) => FENCED.test(line)).length;
        console.error(`entry: passed over what macOS won't let root touch (${fenced})`);
        return resolve();
      }
      reject(new Error(`tar exited ${code}`));
    });
  });
}

/**
 * The home folder as a gzipped tar on stdout, without its caches or the
 * volume's own folders, and without macOS's own metadata (extended
 * attributes, ACLs and flags), as GNU tar leaves them out on Linux: macOS's
 * tar writes a big one (an app's cache's resource fork) as a header too big
 * for it to read back.
 */
function archiveHome(): Promise<void> {
  const excludes = [...HOME_ARCHIVE_EXCLUDES, ...VOLUME_FOLDERS.map((f) => `nibblet/${f}`)];
  return fencedTar(
    [
      "--no-mac-metadata",
      "--no-xattrs",
      "--no-acls",
      "--no-fflags",
      "-C",
      path.dirname(HOME),
      "-czf",
      "-",
      ...excludes.map((e) => `--exclude=${e}`),
      path.basename(HOME),
    ],
    "out",
  );
}

/**
 * Empties the home folder and unpacks one from stdin over it. Only ever of
 * a nibblet that's stopped, in a VM booted for it; but the VM signed the
 * agent's user in to the desktop at boot, whose session is ended first, so
 * nothing writes to its Library meanwhile. What can't be emptied is what
 * macOS won't let root touch, which no archive has either.
 */
async function restoreHome(): Promise<void> {
  // Signed out (launchd would start its agents again), then whatever's left.
  await run("launchctl", ["bootout", `gui/${AGENT_UID}`]).catch(() => undefined);
  await run("launchctl", ["bootout", `user/${AGENT_UID}`]).catch(() => undefined);
  await run("pkill", ["-KILL", "-u", "nibblet"]).catch(() => undefined);
  for (let i = 0; i < 40; i++) {
    const left = await run("pgrep", ["-u", "nibblet"]).then(
      () => true,
      () => false,
    );
    if (!left) break;
    await sleep(250);
  }
  await inherit("sh", ["-c", `${emptyHome()} || true`]);
  await fencedTar(["-C", path.dirname(HOME), "-xzpf", "-"], "in");
}

/** The shell command that empties the home folder, but for the volume's own folders. */
export function emptyHome(): string {
  const keep = VOLUME_FOLDERS.map((f) => `! -name '${f}'`).join(" ");
  return `find ${HOME} -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} +`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const macos: EntryPlatform = {
  home: HOME,
  // In the agent's desktop session, where its windows are seen.
  ocu: { command: "/usr/bin/sudo", args: ["-n", SESSION_SCRIPT] },
  pids: "/var/run/nibblet-subagents",
  guardEnv: ["PATH", "LANG", "TZ", "NODE_ENV"],

  async prepare() {
    await users(log);
    const joining = process.env.NIBBLET_TAILSCALE === "1";
    const leaving = !joining && tailscaleLeft();
    const fence = joining
      ? { uid: TAILSCALE_UID, ports: tailnetPorts(process.env.NIBBLET_TAILSCALE_PORTS) }
      : leaving
        ? { uid: TAILSCALE_UID, ports: [] }
        : null;
    const blocked = await firewall(fence);
    await folders();
    await sessionScript();
    if (existsSync(OCU_APP)) {
      await waitForDesktop(log).catch((err: unknown) =>
        log(
          `couldn't sign in to the desktop, so there's no browser or desktop: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } else {
      log("there's no OpenComputerUse in this machine's image, so no browser or desktop");
    }
    let tailscale: ChildProcess | null = null;
    if (fence && !(leaving && blocked)) {
      try {
        await tailscaleFolders();
        tailscale = startTailscale(blocked, leaving);
      } catch (err) {
        log(`couldn't start Tailscale: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return async () => {
      if (tailscale?.pid && tailscale.exitCode === null) {
        try {
          process.kill(-tailscale.pid, "SIGTERM");
        } catch {
          // Gone already.
        }
      }
    };
  },

  leaveTailnet,

  ownedDir(dir, who, mode) {
    return who === "guard"
      ? ownedDir(dir, GUARD_UID, GUARD_GID, mode)
      : ownedDir(dir, AGENT_UID, AGENT_GID, mode);
  },

  async link(to, at) {
    if (!(await exists(at))) await symlink(to, at);
  },

  tmpDir: (id) => `/private/tmp/nibblet-${id}`,
  runtimeDir: () => null,

  spawn(who, script, env, opts) {
    // Node drops the supplementary groups and takes the uid and gid before it starts the script.
    const [uid, gid] = who === "guard" ? [GUARD_UID, GUARD_GID] : [AGENT_UID, AGENT_GID];
    return spawn(process.execPath, [path.join(scripts, script)], {
      uid,
      gid,
      env,
      stdio: "inherit",
      detached: opts.group,
      // Its working folder, which the runner works in: launchd starts the agent in /.
      cwd: who === "guard" ? GUARD_HOME : path.join(HOME, "work"),
    });
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

  archiveHome,

  restoreHome,
};
