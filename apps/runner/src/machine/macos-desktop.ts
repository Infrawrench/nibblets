/**
 * A macOS guest's users, and the agent's desktop session. macOS signs a
 * user in by itself only at boot, as the login window first starts, and
 * only with a password it was given from inside the login window's own
 * session (sysadminctl's automatic login, which no longer has a file of
 * its own). So the image has an agent that runs in that session
 * (SIGNIN_REQUEST, machine-apple's provision.ts), and its /etc/fstab mounts
 * the home disk over the agent's home at boot, before anyone signs in.
 *
 * The guest agent makes the users at boot and, the first time (a new VM,
 * or a new image), has the login window turn on the automatic login and
 * restarts the guest: every boot after signs the agent's user in to its
 * own home. The entry waits for that session (waitForDesktop).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, chown, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GID,
  AGENT_UID,
  GUARD_GID,
  GUARD_UID,
  TAILSCALE_GID,
  TAILSCALE_UID,
} from "@nibblets/protocol";
import { MACOS_TAILSCALE } from "../tailscale.ts";

const run = promisify(execFile);
const HOME = "/Users/nibblet";
const USER = "nibblet";
/**
 * The agent's user's password, for signing it in to the desktop: on its
 * home disk, so its login keychain opens with it whichever image it boots,
 * and root's alone.
 */
const LOGIN_SECRET = path.join(HOME, ".nibblet-login");
/**
 * Where the guest agent asks the login window's agent to turn on the
 * automatic login, with the password, and where it answers: root's alone.
 * The same paths as provision.ts's SIGNIN_SH.
 */
export const SIGNIN_DIR = "/private/var/db/nibblets";
const SIGNIN_REQUEST = path.join(SIGNIN_DIR, "signin.request");
const SIGNIN_RESULT = path.join(SIGNIN_DIR, "signin.result");
/** How long the login window's agent gets to answer, and a session to start. */
const SIGNIN_ANSWER_MS = 60_000;
const SESSION_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/**
 * Commands of the desktop's, which each get a minute: one that waits on
 * something (dscl, for a password it can't ask for) mustn't hold anything
 * up for good.
 */
const quick = (cmd: string, args: string[]) => run(cmd, args, { timeout: 60_000 });

/** The users, as dscl makes them: the agent's own group, the guard's, and Tailscale's. */
export const USERS = [
  {
    name: USER,
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
    home: path.join(HOME, ".guard"),
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
 * one to sign in to the desktop with. macOS gives each its GeneratedUID
 * itself, and won't have it set.
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
 * only set what they name, so running them again is safe).
 */
export async function users(log: (message: string) => void): Promise<void> {
  for (const user of USERS) {
    const uid = await quick("dscl", [".", "-read", `/Users/${user.name}`, "UniqueID"]).then(
      (r) => r.stdout.trim(),
      () => "",
    );
    if (uid === `UniqueID: ${user.uid}`) continue;
    for (const args of userCommands(user)) await quick("dscl", [".", ...args]);
    log(`made the ${user.name} user`);
  }
}

/** Whether the agent's user has a password yet: dscl makes it with none. */
async function hasPassword(): Promise<boolean> {
  const authority = await quick("dscl", [
    ".",
    "-read",
    `/Users/${USER}`,
    "AuthenticationAuthority",
  ]).then(
    (r) => r.stdout,
    () => "",
  );
  return authority.includes(";ShadowHash;");
}

/** Who's signed in to the desktop, if anyone: the console's owner. */
export async function consoleUser(): Promise<string | null> {
  const owner = await quick("stat", ["-f", "%Su", "/dev/console"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  return owner && owner !== "root" ? owner : null;
}

/** Setup Assistant's first-login screens, as its preferences name them. */
export const SETUP_SCREENS = [
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

/**
 * The first-login screens that would stand in front of the desktop (an
 * Apple Account, Siri, Screen Time and the rest), as seen, in the agent's
 * own preferences: a plist file, written with plutil, since cfprefsd has
 * nothing to do with a user who isn't signed in. Once for each build.
 */
async function skipSetupScreens(): Promise<void> {
  const [version, build] = await Promise.all([
    quick("sw_vers", ["-productVersion"]).then((r) => r.stdout.trim()),
    quick("sw_vers", ["-buildVersion"]).then((r) => r.stdout.trim()),
  ]);
  const library = path.join(HOME, "Library");
  const prefs = path.join(library, "Preferences");
  const file = path.join(prefs, "com.apple.SetupAssistant.plist");
  const seen = await quick("plutil", [
    "-extract",
    "LastSeenBuddyBuildVersion",
    "raw",
    "-o",
    "-",
    file,
  ]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  if (seen === build) return;
  for (const dir of [library, prefs]) {
    await mkdir(dir, { recursive: true });
    await chown(dir, AGENT_UID, AGENT_GID);
  }
  if (!(await exists(file))) await quick("plutil", ["-create", "xml1", file]);
  const set = (key: string, type: "-bool" | "-string", value: string) =>
    quick("plutil", ["-replace", key, type, value, file]);
  for (const key of SETUP_SCREENS) await set(key, "-bool", "YES");
  for (const key of ["LastSeenCloudProductVersion", "LastSeenDiagnosticsProductVersion"])
    await set(key, "-string", version);
  await set("LastSeenBuddyBuildVersion", "-string", build);
  await set("SkipFirstLoginOptimization", "-bool", "YES");
  await chown(file, AGENT_UID, AGENT_GID);
}

/** The agent's user's password: the one its home disk keeps, or a new one, set either way. */
async function password(): Promise<string> {
  let secret = (await readFile(LOGIN_SECRET, "utf8").catch(() => "")).trim();
  if (!secret) {
    secret = randomBytes(18).toString("base64url");
    await quick("dscl", [".", "-passwd", `/Users/${USER}`, secret]);
    await writeFile(LOGIN_SECRET, secret, { mode: 0o600 });
    await chown(LOGIN_SECRET, 0, 0);
    // A keychain from before is locked with a password that's gone.
    await rm(path.join(HOME, "Library", "Keychains"), { recursive: true, force: true });
  } else if (!(await hasPassword())) {
    // A new image's user: the same as before, for its keychain. Once it has
    // one, it's left alone: signed in, macOS guards it with a secure token.
    await quick("dscl", [".", "-passwd", `/Users/${USER}`, secret]);
  }
  return secret;
}

/** Whether the login window signs the agent's user in by itself. */
async function signsIn(): Promise<boolean> {
  const status = await quick("sysadminctl", ["-autologin", "status"]).then(
    (r) => `${r.stdout}${r.stderr}`,
    () => "",
  );
  return status.includes(`Automatic login user: ${USER}`);
}

/**
 * Has the login window's agent turn on the automatic login for the agent's
 * user, with its password: only it can, from its session. Throws with what
 * it said when it doesn't.
 */
async function turnOnSigningIn(secret: string): Promise<void> {
  await mkdir(SIGNIN_DIR, { recursive: true, mode: 0o700 });
  await chmod(SIGNIN_DIR, 0o700);
  await rm(SIGNIN_RESULT, { force: true });
  await writeFile(`${SIGNIN_REQUEST}.new`, secret, { mode: 0o600 });
  // Whole, or not at all: the agent takes the request as soon as it's there.
  await rename(`${SIGNIN_REQUEST}.new`, SIGNIN_REQUEST);
  try {
    const until = Date.now() + SIGNIN_ANSWER_MS;
    while (!(await exists(SIGNIN_RESULT))) {
      if (Date.now() > until) throw new Error("the login window's agent didn't answer");
      await sleep(1000);
    }
    if (!(await signsIn())) {
      const said = (await readFile(SIGNIN_RESULT, "utf8").catch(() => "")).trim();
      throw new Error(`the login window didn't turn on signing in: ${said}`);
    }
  } finally {
    await rm(SIGNIN_REQUEST, { force: true });
  }
}

/**
 * At boot, with its home disk mounted: the users, and the agent's desktop.
 * Returns "restart" when the guest is to be restarted, to sign in.
 */
export async function prepareDesktop(log: (message: string) => void): Promise<"ready" | "restart"> {
  await users(log);
  // Before its first sign-in, which would show them otherwise.
  await skipSetupScreens();
  const secret = await password();
  if ((await consoleUser()) === USER || (await signsIn())) return "ready";
  log("turning on signing in to the desktop, then restarting");
  await turnOnSigningIn(secret);
  return "restart";
}

/** The end of what the login window logged lately, to say why a sign-in didn't happen. */
async function loginwindowSaid(): Promise<string> {
  return quick("log", [
    "show",
    "--last",
    "5m",
    "--style",
    "compact",
    "--predicate",
    'process == "loginwindow"',
  ]).then(
    (r) => r.stdout.trim().split("\n").slice(-15).join("\n"),
    (err: unknown) =>
      `(its log couldn't be read: ${err instanceof Error ? err.message : String(err)})`,
  );
}

/** Waits for the agent's user's desktop session, which the guest signed in to at boot. */
export async function waitForDesktop(log: (message: string) => void): Promise<void> {
  const until = Date.now() + SESSION_MS;
  while ((await consoleUser()) !== USER) {
    if (Date.now() > until) {
      throw new Error(
        `its user isn't signed in to the desktop. The login window said:\n${await loginwindowSaid()}`,
      );
    }
    await sleep(1000);
  }
  log("signed in to the desktop");
}
