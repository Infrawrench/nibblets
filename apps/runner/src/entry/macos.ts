/**
 * macOS, in a VM: two hidden users made with dscl (the agent, and the
 * guard), each started with Node's own uid and gid; folders as on Linux;
 * and pf for the firewall, in an anchor under the com.apple one the stock
 * rules already load, so nothing of the system's is touched. No browser
 * or Tailscale yet.
 */
import { execFile, spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AGENT_GID,
  AGENT_UID,
  GUARD_GID,
  GUARD_UID,
  HOME_ARCHIVE_EXCLUDES,
} from "@nibblets/protocol";
import { ownSubnet } from "./linux.ts";
import { inherit, sleep } from "./shared.ts";
import type { EntryPlatform } from "./platform.ts";

const run = promisify(execFile);
const HOME = "/Users/nibblet";
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
const scripts = fileURLToPath(new URL("..", import.meta.url));
/** Where the rules go: the stock pf.conf loads every anchor under com.apple. */
export const PF_ANCHOR = "com.apple/250.Nibblets";

const log = (message: string) => console.log(`entry: ${message}`);

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** The users, as dscl makes them: the agent's own group, and the guard's. */
export const USERS = [
  {
    name: "nibblet",
    uid: AGENT_UID,
    gid: AGENT_GID,
    group: "nibblet",
    home: HOME,
    shell: "/bin/zsh",
  },
  {
    name: "_nibbletguard",
    uid: GUARD_UID,
    gid: GUARD_GID,
    group: "_nibbletguard",
    home: GUARD_HOME,
    shell: "/usr/bin/false",
  },
];

/** The dscl commands that make a user that isn't there yet, hidden from the login window. */
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
    ["-create", u, "RealName", user.name === "nibblet" ? "Nibblet" : "Nibblet guard"],
    ["-create", u, "IsHidden", "1"],
    // No password: nobody logs in as them; the entry starts them by uid.
    ["-create", u, "Password", "*"],
  ];
}

async function users(): Promise<void> {
  for (const user of USERS) {
    const there = await run("dscl", [".", "-read", `/Users/${user.name}`]).then(
      () => true,
      () => false,
    );
    if (there) continue;
    for (const args of userCommands(user)) await run("dscl", [".", ...args]);
    log(`made the ${user.name} user`);
  }
}

/** pf's rules: what the agent may reach on its VM's network (the host, its DNS), then what it may not. */
export function pfRules(subnet: string | null, gateway: string | null): string {
  return [
    // Cloud metadata services hand out a VM's own credentials.
    "block drop out quick inet from any to 169.254.0.0/16",
    ...(subnet
      ? [
          ...(gateway ? [`pass out quick inet from any to ${gateway}`] : []),
          `block drop out quick inet from any to ${subnet}`,
        ]
      : []),
    "",
  ].join("\n");
}

async function firewall(): Promise<void> {
  const subnet = ownSubnet();
  const gateway = await run("route", ["-n", "get", "default"]).then(
    (r) => /gateway:\s*(\S+)/.exec(r.stdout)?.[1] ?? null,
    () => null,
  );
  try {
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
      child.stdin.end(pfRules(subnet, gateway));
    });
    // On, whether it was or not; pf counts who asked, so this never turns off anyone else's.
    await run("pfctl", ["-E"]).catch(() => undefined);
    log(`firewall up (allowing ${gateway ?? "nothing"} on ${subnet ?? "no subnet"})`);
  } catch (err) {
    log(`couldn't set the firewall: ${err instanceof Error ? err.message : String(err)}`);
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
  pids: "/var/run/nibblet-subagents",
  guardEnv: ["PATH", "LANG", "TZ", "NODE_ENV"],

  async prepare() {
    await users();
    await firewall();
    await folders();
    return async () => {};
  },

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
      ...HOME_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`),
      path.basename(HOME),
    ]),

  restoreHome: () =>
    inherit("sh", [
      "-c",
      `find ${HOME} -mindepth 1 -delete && tar -C ${path.dirname(HOME)} -xzpf -`,
    ]),
};
