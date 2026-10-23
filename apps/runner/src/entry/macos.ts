/**
 * macOS, in a VM: three hidden users made with dscl (the agent, the guard,
 * and Tailscale's), each started with Node's own uid and gid; folders as on
 * Linux; and pf for the firewall, in an anchor under the com.apple one the
 * stock rules already load, so nothing of the system's is touched.
 *
 * The agent's user is signed in to the desktop, once its home disk is
 * mounted, as Windows' is at boot: the browser (Google Chrome) and the
 * desktop's apps are OpenComputerUse's, run as that user in that session.
 * The guard starts its OpenComputerUse through sudo, which may run only
 * the session script (SESSION_SCRIPT) for it, with its two tokens.
 *
 * Tailscale's tailscaled, built by the image's bootstrap, runs as its own
 * user in userspace networking, as on Linux, with pf fencing in what that
 * user may reach on loopback.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
/**
 * The agent's user's password, for signing it in to the desktop: on its
 * home disk, so its login keychain opens with it whichever image it boots,
 * and root's alone.
 */
const LOGIN_SECRET = path.join(HOME, ".nibblet-login");
/** How long signing in to the desktop may take: making a new user's session is slow. */
const SIGN_IN_MS = 3 * 60_000;

const log = (message: string) => console.log(`entry: ${message}`);

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** The users, as dscl makes them: the agent's own group, the guard's, and Tailscale's. */
export const USERS = [
  {
    name: "nibblet",
    uid: AGENT_UID,
    gid: AGENT_GID,
    group: "nibblet",
    home: HOME,
    shell: "/bin/zsh",
    realName: "Nibblet",
  },
  {
    name: "_nibbletguard",
    uid: GUARD_UID,
    gid: GUARD_GID,
    group: "_nibbletguard",
    home: GUARD_HOME,
    shell: "/usr/bin/false",
    realName: "Nibblet guard",
  },
  {
    name: "_nibblettailscale",
    uid: TAILSCALE_UID,
    gid: TAILSCALE_GID,
    group: "_nibblettailscale",
    home: MACOS_TAILSCALE.state,
    shell: "/usr/bin/false",
    realName: "Nibblet Tailscale",
  },
];

/**
 * The dscl commands that make a user that isn't there yet, hidden from the
 * login window. None has a password to begin with; the agent's is given
 * one to sign in to the desktop with (`signIn`).
 */
export function userCommands(user: (typeof USERS)[number]): string[][] {
  const g = `/Groups/${user.group}`;
  const u = `/Users/${user.name}`;
  return [
    ["-create", g],
    ["-create", g, "PrimaryGroupID", String(user.gid)],
    ["-create", u],
    ["-create", u, "UniqueID", String(user.uid)],
    ["-create", u, "PrimaryGroupID", String(user.gid)],
    ["-create", u, "NFSHomeDirectory", user.home],
    ["-create", u, "UserShell", user.shell],
    ["-create", u, "RealName", user.realName],
    ["-create", u, "IsHidden", "1"],
    ["-create", u, "Password", "*"],
  ];
}

/**
 * Makes each user that isn't there yet, or wasn't finished (the commands
 * only set what they name, so running them again is safe). macOS gives
 * each its GeneratedUID itself, and won't have it set.
 */
async function users(): Promise<void> {
  for (const user of USERS) {
    const uid = await run("dscl", [".", "-read", `/Users/${user.name}`, "UniqueID"]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    if (uid === `UniqueID: ${user.uid}`) continue;
    for (const args of userCommands(user)) await run("dscl", [".", ...args]);
    log(`made the ${user.name} user`);
  }
}

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
 * the agent's user, with nothing else of its caller's.
 */
export const SESSION_SH = `#!/bin/sh
set -eu
uid=$(/usr/bin/id -u nibblet)
cd /Users/nibblet/work
exec /bin/launchctl asuser "$uid" /usr/bin/sudo -n -H -u nibblet \\
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

/** macOS's obfuscation of an automatic login's password, in /etc/kcpassword. */
export function kcpassword(password: string): Buffer {
  const key = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f];
  const plain = Buffer.from(`${password}\0`, "utf8");
  const out = Buffer.alloc(Math.ceil(plain.length / 12) * 12);
  plain.copy(out);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) ^ (key[i % key.length] ?? 0);
  return out;
}

/** Who's signed in to the desktop, if anyone: the console's owner. */
async function consoleUser(): Promise<string | null> {
  const owner = await run("stat", ["-f", "%Su", "/dev/console"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  return owner && owner !== "root" ? owner : null;
}

/**
 * The first-login screens that would stand in front of the desktop (an
 * Apple Account, Siri, Screen Time and the rest), as seen, in the agent's
 * own preferences.
 */
async function skipSetupScreens(version: string, build: string): Promise<void> {
  const prefs = path.join(HOME, "Library", "Preferences");
  await mkdir(prefs, { recursive: true });
  const file = path.join(prefs, "com.apple.SetupAssistant.plist");
  const seen = [
    "DidSeeAccessibility",
    "DidSeeActivationLock",
    "DidSeeAppearanceSetup",
    "DidSeeApplePaySetup",
    "DidSeeAvatarSetup",
    "DidSeeCloudSetup",
    "DidSeeIntelligence",
    "DidSeeLockdownMode",
    "DidSeePrivacy",
    "DidSeeScreenTime",
    "DidSeeSiriSetup",
    "DidSeeSyncSetup",
    "DidSeeSyncSetup2",
    "DidSeeTermsOfAddress",
    "DidSeeTouchIDSetup",
    "DidSeeTrueTonePrivacy",
    "DidSeeWalletSetup",
    "DidSeeiCloudLoginForStorageServices",
  ];
  for (const key of seen) await run("defaults", ["write", file, key, "-bool", "true"]);
  for (const key of ["LastSeenCloudProductVersion", "LastSeenDiagnosticsProductVersion"])
    await run("defaults", ["write", file, key, "-string", version]);
  await run("defaults", ["write", file, "LastSeenBuddyBuildVersion", "-string", build]);
  await run("defaults", ["write", file, "SkipFirstLoginOptimization", "-bool", "true"]);
  await run("chown", ["-R", `${AGENT_UID}:${AGENT_GID}`, path.join(HOME, "Library")]);
}

/**
 * Signs the agent's user in to the desktop, unless it is already, and waits
 * until it is. Only now, with its home disk mounted, never at boot: an
 * automatic login is set just for this one and taken away again.
 */
async function signIn(): Promise<void> {
  if ((await consoleUser()) === "nibblet") return;
  let password = (await readFile(LOGIN_SECRET, "utf8").catch(() => "")).trim();
  if (!password) {
    password = randomBytes(18).toString("base64url");
    await run("dscl", [".", "-passwd", "/Users/nibblet", password]);
    await writeFile(LOGIN_SECRET, password, { mode: 0o600 });
    await chown(LOGIN_SECRET, 0, 0);
    // A keychain from before is locked with a password that's gone.
    await rm(path.join(HOME, "Library", "Keychains"), { recursive: true, force: true });
  } else {
    // A new image's user hasn't one yet: the same as before, for its keychain.
    await run("dscl", [".", "-passwd", "/Users/nibblet", password]);
  }
  const [version, build] = await Promise.all([
    run("sw_vers", ["-productVersion"]).then((r) => r.stdout.trim()),
    run("sw_vers", ["-buildVersion"]).then((r) => r.stdout.trim()),
  ]);
  await skipSetupScreens(version, build);
  await writeFile("/private/etc/kcpassword", kcpassword(password), { mode: 0o600 });
  const loginwindow = "/Library/Preferences/com.apple.loginwindow";
  await run("defaults", ["write", loginwindow, "autoLoginUser", "nibblet"]);
  try {
    // The login window starts again, and signs in as autoLoginUser.
    await run("killall", ["loginwindow"]).catch(() => undefined);
    const until = Date.now() + SIGN_IN_MS;
    while ((await consoleUser()) !== "nibblet") {
      if (Date.now() > until) throw new Error("its user didn't sign in to the desktop");
      await sleep(1000);
    }
    log("signed in to the desktop");
  } finally {
    await run("defaults", ["delete", loginwindow, "autoLoginUser"]).catch(() => undefined);
    await rm("/private/etc/kcpassword", { force: true });
  }
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
    await users();
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
      await signIn().catch((err: unknown) =>
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

  archiveHome: () =>
    inherit("tar", [
      "-C",
      path.dirname(HOME),
      "-czf",
      "-",
      ...[...HOME_ARCHIVE_EXCLUDES, ...VOLUME_FOLDERS.map((f) => `nibblet/${f}`)].map(
        (e) => `--exclude=${e}`,
      ),
      path.basename(HOME),
    ]),

  restoreHome: () =>
    inherit("sh", ["-c", `${emptyHome()} && tar -C ${path.dirname(HOME)} -xzpf -`]),
};
