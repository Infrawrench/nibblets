/**
 * Windows, in a VM. The guard runs as SYSTEM, which a standard user can't
 * read the memory, environment or files of; the agent runs as `nibblet`, a
 * hidden local user, started by nibblet-runas.exe (machine/windows/runas.cs),
 * which logs it on and ends its whole tree when it ends. Folders are fenced
 * with ACLs, and the firewall is Windows Firewall's, in a group of its own.
 * Windows has no SIGTERM for a console process, so stopping is at once.
 *
 * Tailscale's tailscaled runs as SYSTEM, its CLI as a third user, and it's
 * fenced in by nibblet-fence (machine/windows/fence.cs): see tailscale.ts.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOME_ARCHIVE_EXCLUDES } from "@nibblets/protocol";
import { TAILSCALE_USER, WINDOWS_TAILSCALE } from "../tailscale.ts";
import { ownSubnet, tailnetPorts } from "./linux.ts";
import { inherit, pick, sleep } from "./shared.ts";
import type { EntryPlatform, Who } from "./platform.ts";

const run = promisify(execFile);
const win = path.win32;
const HOME = "C:\\Users\\nibblet";
export const NIBBLETS_DATA = "C:\\ProgramData\\Nibblets";
/** Each of its users' passwords, for runas to log them on with: SYSTEM's and Administrators' alone. */
export const USER_SECRETS = win.join(NIBBLETS_DATA, "users");
export const RUNAS = "C:\\Nibblets\\bin\\nibblet-runas.exe";
const FENCE = "C:\\Nibblets\\bin\\nibblet-fence.exe";
/** Downloaded by the bootstrap, for its browser and desktop (x64 only). */
const OCU = "C:\\Nibblets\\bin\\opencomputeruse.exe";
const scripts = () => fileURLToPath(new URL("..", import.meta.url));
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

const log = (message: string) => console.log(`entry: ${message}`);

/** PowerShell, with its parameters as JSON in the environment (`$p`), never in the script. */
async function ps(script: string, params: object = {}): Promise<string> {
  const full = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$p = $env:NIBBLET_PS | ConvertFrom-Json\n${script}`;
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(full, "utf16le").toString("base64"),
    ],
    { env: { ...process.env, NIBBLET_PS: JSON.stringify(params) }, windowsHide: true },
  );
  return stdout;
}

const ipToInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/**
 * The subnet as address ranges with `except` left out of them. Windows
 * Firewall's block rules win over its allow rules, so "the network but the
 * host" has to be said as everything around the host.
 */
export function rangesExcept(cidr: string, except: string | null): string[] {
  const [ip, bits] = cidr.split("/");
  if (!ip || !bits) return [];
  const size = 2 ** (32 - Number(bits));
  const start = ipToInt(ip);
  const end = start + size - 1;
  const hole = except ? ipToInt(except) : -1;
  if (hole < start || hole > end) return [`${intToIp(start)}-${intToIp(end)}`];
  return [
    ...(hole > start ? [`${intToIp(start)}-${intToIp(hole - 1)}`] : []),
    ...(hole < end ? [`${intToIp(hole + 1)}-${intToIp(end)}`] : []),
  ];
}

/**
 * icacls's arguments to make a folder `who`'s alone (and SYSTEM's, which
 * runs everything). The agent's user is given by its SID: by name,
 * "nibblet" can be the computer, where that's its name too.
 */
export function aclArgs(dir: string, who: Who | "downloads", agentSid: string): string[] {
  const agent = `*${agentSid}`;
  const grants =
    who === "guard"
      ? [`${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`]
      : who === "agent"
        ? [`${SYSTEM}:(OI)(CI)F`, `${agent}:(OI)(CI)M`]
        : // The browser's downloads: the guard's to write, the agent's to read.
          [`${SYSTEM}:(OI)(CI)F`, `${agent}:(OI)(CI)RX`];
  return [dir, "/inheritance:r", "/grant:r", ...grants, "/Q"];
}

/** A hidden local user, with its password where runas finds it; made once. */
async function localUser(name: string, description: string): Promise<void> {
  const secret = win.join(USER_SECRETS, `${name}.json`);
  if (existsSync(secret)) return;
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  await ps(
    `$pw = ConvertTo-SecureString $p.password -AsPlainText -Force
if (Get-LocalUser -Name $p.name -ErrorAction SilentlyContinue) { Set-LocalUser -Name $p.name -Password $pw }
else { New-LocalUser -Name $p.name -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description $p.description | Out-Null }
Add-LocalGroupMember -Group 'Users' -Member $p.name -ErrorAction SilentlyContinue
# Not on the sign-in screen: nobody signs in as it.
$list = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $list -Force | Out-Null
New-ItemProperty -Path $list -Name $p.name -Value 0 -PropertyType DWord -Force | Out-Null`,
    { name, description, password },
  );
  await writeFile(secret, JSON.stringify({ user: name, password }));
  log(`made the ${name} user`);
}

async function users(): Promise<void> {
  await mkdir(USER_SECRETS, { recursive: true });
  // What's made in it is SYSTEM's and Administrators' alone too.
  await run("icacls", [
    USER_SECRETS,
    "/inheritance:r",
    "/grant:r",
    `${SYSTEM}:(OI)(CI)F`,
    `${ADMINISTRATORS}:(OI)(CI)F`,
    "/Q",
  ]);
  await localUser("nibblet", "Nibblets agent");
  await localUser(TAILSCALE_USER, "Nibblets' Tailscale");
}

async function firewall(): Promise<void> {
  const subnet = ownSubnet(networkInterfaces());
  const gateway = await ps(
    "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop",
  ).then(
    (out) => out.trim() || null,
    () => null,
  );
  try {
    await ps(
      `Get-NetFirewallRule -Group 'Nibblets' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Group 'Nibblets' -DisplayName 'Nibblets: no cloud metadata' -Direction Outbound -Action Block -RemoteAddress '169.254.0.0/16' | Out-Null
foreach ($r in $p.ranges) {
  New-NetFirewallRule -Group 'Nibblets' -DisplayName "Nibblets: not its network ($r)" -Direction Outbound -Action Block -RemoteAddress $r | Out-Null
}`,
      { ranges: subnet ? rangesExcept(subnet, gateway) : [] },
    );
    log(`firewall up (allowing ${gateway ?? "nothing"} on ${subnet ?? "no subnet"})`);
  } catch (err) {
    log(`couldn't set the firewall: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A local user's SID, once it's made. */
const sids = new Map<string, Promise<string>>();
function sidOf(name: string): Promise<string> {
  let sid = sids.get(name);
  if (!sid) {
    sid = ps("(Get-LocalUser -Name $p.name).SID.Value", { name }).then((out) => {
      const sid = out.trim();
      if (!/^S-1-5-21-[\d-]+$/.test(sid))
        throw new Error(`the ${name} user's SID isn't one: ${sid}`);
      return sid;
    });
    sids.set(name, sid);
  }
  return sid;
}
const agentUser = () => sidOf("nibblet");

async function ownedDir(dir: string, who: Who | "downloads"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run("icacls", aclArgs(dir, who, await agentUser()));
}

async function folders(): Promise<void> {
  await ownedDir(HOME, "agent");
  await mkdir(win.join(HOME, "work"), { recursive: true });
  await ownedDir(win.join(HOME, ".guard"), "guard");
  await ownedDir(win.join(HOME, "Downloads"), "downloads");
  const link = win.join(HOME, ".guard", "Downloads");
  if (!existsSync(link)) await symlink(win.join(HOME, "Downloads"), link, "junction");
}

/**
 * Tailscale's folders: its state, tailscaled's (SYSTEM's) alone; and where
 * its key waits for `tailscale up`, which its user reads.
 */
async function tailscaleFolders(): Promise<void> {
  const own = async (dir: string, grants: string[]) => {
    await mkdir(dir, { recursive: true });
    await run("icacls", [dir, "/inheritance:r", "/grant:r", ...grants, "/Q"]);
  };
  await own(WINDOWS_TAILSCALE.state, [`${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`]);
  await own(WINDOWS_TAILSCALE.run, [
    `${SYSTEM}:(OI)(CI)F`,
    `*${await sidOf(TAILSCALE_USER)}:(OI)(CI)RX`,
  ]);
}

/**
 * Starts Tailscale, to join, or (`leave`) to sign out the machine a
 * nibblet taken off the tailnet left behind. The fence comes first: without
 * it, it doesn't join, and the user's told why.
 */
async function startTailscale(leave = false): Promise<ChildProcess | null> {
  if (!existsSync(WINDOWS_TAILSCALE.tailscaled)) {
    log("there's no Tailscale in this machine's image");
    return null;
  }
  const ports = leave ? [] : tailnetPorts(process.env.NIBBLET_TAILSCALE_PORTS);
  let blocked: string | null = null;
  try {
    await run(FENCE, [WINDOWS_TAILSCALE.tailscaled, ...ports.map(String)]);
    log(`tailnet may reach ${ports.length ? `ports ${ports.join(", ")}` : "nothing"}`);
    await tailscaleFolders();
  } catch (err) {
    blocked = `Couldn't fence off the machine from the tailnet, so it hasn't joined: ${err instanceof Error ? err.message : String(err)}`;
    // Leaving is tidying up: not worth being on the tailnet unfenced for.
    if (leave) return null;
  }
  const child = spawn(process.execPath, [path.join(scripts(), "tailscale.ts")], {
    env: {
      ...pick([
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SystemDrive",
        "windir",
        "TEMP",
        "TMP",
        "NODE_ENV",
      ]),
      ...pick(["NIBBLET_ID", "NIBBLET_SERVER_URL", "NIBBLET_GUARD_TOKEN"]),
      ...(blocked ? { NIBBLET_TAILSCALE_BLOCKED: blocked } : {}),
      ...(leave ? { NIBBLET_TAILSCALE_LEAVE: "1" } : {}),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  // The nibblet carries on without it: the user sees why on its settings.
  child.on("exit", (code) => log(`tailscale stopped (${code})`));
  child.on("error", (err) => log(`tailscale: ${err.message}`));
  return child;
}

/** `entry.ts tailscale-leave`: just signs out the machine a nibblet left. */
async function leaveTailnet(): Promise<void> {
  if (!existsSync(win.join(WINDOWS_TAILSCALE.state, "tailscaled.state"))) return;
  const child = await startTailscale(true);
  if (child) await new Promise((resolve) => child.once("exit", resolve));
}

/** Ends a process and everything it started; Windows has no gentler way for a console process. */
async function killTree(pid: number): Promise<void> {
  await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The home disk's own folders, at its root, as the home is mounted there:
 * Windows', which a shadow copy keeps its own storage in. Never archived,
 * and left where they are.
 */
export const VOLUME_FOLDERS = ["System Volume Information", "$RECYCLE.BIN"];

/** Where an archive reads its home's shadow copy from: a link named as the home is, the guard's alone. */
const SHADOW_LINK = win.join(NIBBLETS_DATA, "shadow", win.basename(HOME));

/**
 * A shadow copy of the home disk, which an archive reads rather than the
 * home itself, as a frozen disk is on Linux: what's open (Edge holds its
 * profile's files to itself) is read as it was, and nothing's caught
 * half-written. Any left by an archive that was killed go first.
 */
const SHADOW = `
$part = Get-Partition | Where-Object { $_.AccessPaths -contains ($p.home + '\\') }
$vol = (Get-Volume -Partition $part).Path
Get-CimInstance Win32_ShadowCopy | Where-Object VolumeName -eq $vol | Remove-CimInstance
$made = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{ Volume = $vol; Context = 'ClientAccessible' }
if ($made.ReturnValue -ne 0) { throw "Windows wouldn't shadow its home disk ($($made.ReturnValue))" }
$copy = Get-CimInstance Win32_ShadowCopy | Where-Object ID -eq $made.ShadowID
"$($copy.ID)|$($copy.DeviceObject)"
`;

/** Ends every process of a user (`$p.user`, as `\name`), and waits for them to be gone. */
const ENDED = `
$deadline = (Get-Date).AddSeconds(30)
do {
  $left = @(Get-Process -IncludeUserName | Where-Object { $_.UserName -and $_.UserName.EndsWith($p.user) })
  $left | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($left.Count) { Start-Sleep -Milliseconds 250 }
} while ($left.Count -and (Get-Date) -lt $deadline)
if ($left.Count) { throw "Its user's processes wouldn't end: $(($left.Name | Sort-Object -Unique) -join ', ')" }
`;

/** Shadows the home disk and links to it at SHADOW_LINK; says the shadow copy's id. */
async function shadowHome(): Promise<string> {
  await run("cmd.exe", ["/d", "/c", "rmdir", SHADOW_LINK]).catch(() => undefined);
  await ownedDir(win.dirname(SHADOW_LINK), "guard");
  const said = (await ps(SHADOW, { home: HOME })).trim().split(/\r?\n/).pop() ?? "";
  const [id = "", device = ""] = said.split("|");
  try {
    // Linked to with a trailing backslash, or it isn't a folder.
    await run("cmd.exe", ["/d", "/c", "mklink", "/d", SHADOW_LINK, `${device}\\`]);
  } catch (err) {
    await dropShadow(id);
    throw err;
  }
  return id;
}

async function dropShadow(id: string): Promise<void> {
  // rmdir takes the link away, not what it's to.
  await run("cmd.exe", ["/d", "/c", "rmdir", SHADOW_LINK]).catch(() => undefined);
  await ps(`Get-CimInstance Win32_ShadowCopy | Where-Object ID -eq $p.id | Remove-CimInstance`, {
    id,
  }).catch((err: unknown) => {
    // On stderr: stdout's the archive. The next archive drops it.
    const why = err instanceof Error ? err.message : String(err);
    console.error(`entry: couldn't drop its home's shadow copy: ${why}`);
  });
}

/**
 * Windows' own licensing service, as slmgr uses it: the key goes to it in
 * the environment, never on a command line. Windows itself is the product
 * whose application id this is.
 */
const ACTIVATE = `$windows = "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL"
$now = Get-CimInstance -ClassName SoftwareLicensingProduct -Filter $windows | Where-Object { $_.LicenseStatus -eq 1 }
if ($now -and $now.PartialProductKey -eq $p.key.Substring($p.key.Length - 5)) { 'already'; return }
$service = Get-CimInstance -ClassName SoftwareLicensingService
Invoke-CimMethod -InputObject $service -MethodName InstallProductKey -Arguments @{ ProductKey = $p.key } | Out-Null
Invoke-CimMethod -InputObject $service -MethodName RefreshLicenseStatus | Out-Null
$product = Get-CimInstance -ClassName SoftwareLicensingProduct -Filter $windows | Select-Object -First 1
Invoke-CimMethod -InputObject $product -MethodName Activate | Out-Null
'activated'`;

export const windows: EntryPlatform = {
  home: HOME,
  // In the session the agent's user is signed in to at boot, where its windows are seen.
  ocu: { command: RUNAS, args: ["--session", "nibblet", OCU] },
  pids: win.join(NIBBLETS_DATA, "subagents"),
  guardEnv: ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "NODE_ENV"],

  async prepare() {
    await users();
    await firewall();
    await folders();
    const left = existsSync(win.join(WINDOWS_TAILSCALE.state, "tailscaled.state"));
    const tailscale = await (
      process.env.NIBBLET_TAILSCALE === "1"
        ? startTailscale()
        : left
          ? startTailscale(true)
          : Promise.resolve(null)
    ).catch((err: unknown) => {
      log(`couldn't start Tailscale: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    return async () => {
      if (tailscale?.pid && tailscale.exitCode === null) await killTree(tailscale.pid);
    };
  },

  leaveTailnet,

  ownedDir: (dir, who) => ownedDir(dir, who),

  async link(to, at) {
    if (!existsSync(at)) await symlink(to, at, "junction");
  },

  tmpDir: (id) => win.join(NIBBLETS_DATA, "tmp", id),
  runtimeDir: () => null,

  spawn(who, script, env) {
    const file = path.join(scripts(), script);
    if (who === "guard") {
      return spawn(process.execPath, [file], { env, stdio: "inherit", windowsHide: true });
    }
    return spawn(RUNAS, ["nibblet", process.execPath, file], {
      env,
      stdio: "inherit",
      windowsHide: true,
      cwd: win.join(HOME, "work"),
    });
  },

  killTree(child) {
    if (child.pid) void killTree(child.pid);
  },

  async terminate(pid, graceMs) {
    // Asked first (a windowed app may close), then made.
    await run("taskkill", ["/PID", String(pid), "/T"]).catch(() => undefined);
    for (let waited = 0; waited < Math.min(graceMs, 3000) && alive(pid); waited += 250)
      await sleep(250);
    if (alive(pid)) await killTree(pid);
  },

  async archiveHome() {
    const shadow = await shadowHome();
    try {
      // Each file it reads is said (`-v`, on stderr), so one it sticks on is
      // named; the link it's given is followed (`-H`), and what's in it isn't.
      const excludes = [...HOME_ARCHIVE_EXCLUDES, ...VOLUME_FOLDERS.map((f) => `nibblet/${f}`)];
      await inherit("tar.exe", [
        "-v",
        "-H",
        "-C",
        win.dirname(SHADOW_LINK),
        "-czf",
        "-",
        ...excludes.map((e) => `--exclude=${e}`),
        win.basename(SHADOW_LINK),
      ]);
    } finally {
      await dropShadow(shadow);
    }
  },

  async activateWindows(productKey) {
    const said = (await ps(ACTIVATE, { key: productKey })).trim();
    return said === "already" ? "already" : "activated";
  },

  async restoreHome() {
    // Only ever of a nibblet that's stopped, in a VM booted for it; but the
    // VM signed the agent's user in at boot, where Windows may have started
    // Edge again, holding its profile's files. Everything it runs goes first.
    await ps(ENDED, { user: "\\nibblet" });
    await ps(
      `Get-ChildItem -LiteralPath $p.home -Force | Where-Object Name -notin $p.keep | Remove-Item -Recurse -Force`,
      { home: HOME, keep: VOLUME_FOLDERS },
    );
    await inherit("tar.exe", ["-C", win.dirname(HOME), "-xzf", "-"]);
  },
};
