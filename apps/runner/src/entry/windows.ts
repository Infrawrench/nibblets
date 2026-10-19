/**
 * Windows, in a VM. The guard runs as SYSTEM, which a standard user can't
 * read the memory, environment or files of; the agent runs as `nibblet`, a
 * hidden local user, started by nibblet-runas.exe (machine/windows/runas.cs),
 * which logs it on and ends its whole tree when it ends. Folders are fenced
 * with ACLs, and the firewall is Windows Firewall's, in a group of its own.
 * Windows has no SIGTERM for a console process, so stopping is at once.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HOME_ARCHIVE_EXCLUDES } from "@nibblet/protocol";
import { ownSubnet } from "./linux.ts";
import { inherit, sleep } from "./shared.ts";
import type { EntryPlatform, Who } from "./platform.ts";

const run = promisify(execFile);
const win = path.win32;
const HOME = "C:\\Users\\nibblet";
export const NIBBLETS_DATA = "C:\\ProgramData\\Nibblets";
/** The agent's password, for runas to log it on with: SYSTEM's and Administrators' alone. */
export const AGENT_SECRET = win.join(NIBBLETS_DATA, "agent.json");
export const RUNAS = "C:\\Nibblets\\bin\\nibblet-runas.exe";
const scripts = () => fileURLToPath(new URL("..", import.meta.url));
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

const log = (message: string) => console.log(`entry: ${message}`);

/** PowerShell, with its parameters as JSON in the environment (`$p`), never in the script. */
async function ps(script: string, params: object = {}): Promise<string> {
  const full = `$ErrorActionPreference = 'Stop'\n$p = $env:NIBBLET_PS | ConvertFrom-Json\n${script}`;
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

async function users(): Promise<void> {
  if (existsSync(AGENT_SECRET)) return;
  await mkdir(NIBBLETS_DATA, { recursive: true });
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  await ps(
    `$pw = ConvertTo-SecureString $p.password -AsPlainText -Force
if (Get-LocalUser -Name 'nibblet' -ErrorAction SilentlyContinue) { Set-LocalUser -Name 'nibblet' -Password $pw }
else { New-LocalUser -Name 'nibblet' -Password $pw -PasswordNeverExpires -UserMayNotChangePassword -Description 'Nibblets agent' | Out-Null }
Add-LocalGroupMember -Group 'Users' -Member 'nibblet' -ErrorAction SilentlyContinue
# Not on the sign-in screen: nobody signs in as it.
$list = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $list -Force | Out-Null
New-ItemProperty -Path $list -Name 'nibblet' -Value 0 -PropertyType DWord -Force | Out-Null`,
    { password },
  );
  await writeFile(AGENT_SECRET, JSON.stringify({ user: "nibblet", password }));
  await run("icacls", [
    AGENT_SECRET,
    "/inheritance:r",
    "/grant:r",
    `${SYSTEM}:F`,
    `${ADMINISTRATORS}:F`,
    "/Q",
  ]);
  log("made the nibblet user");
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

/** The agent's user's SID, once it's made. */
let agentSid: Promise<string> | null = null;
function agentUser(): Promise<string> {
  agentSid ??= ps("(Get-LocalUser -Name 'nibblet').SID.Value").then((out) => {
    const sid = out.trim();
    if (!/^S-1-5-21-[\d-]+$/.test(sid)) throw new Error(`the nibblet user's SID isn't one: ${sid}`);
    return sid;
  });
  return agentSid;
}

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
  pids: win.join(NIBBLETS_DATA, "subagents"),
  guardEnv: ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "NODE_ENV"],

  async prepare() {
    await users();
    await firewall();
    await folders();
    return async () => {};
  },

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

  // Each file it reads is said (`-v`, on stderr), so one it sticks on is named.
  archiveHome: () =>
    inherit("tar.exe", [
      "-v",
      "-C",
      win.dirname(HOME),
      "-czf",
      "-",
      ...HOME_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`),
      win.basename(HOME),
    ]),

  async activateWindows(productKey) {
    const said = (await ps(ACTIVATE, { key: productKey })).trim();
    return said === "already" ? "already" : "activated";
  },

  async restoreHome() {
    await ps(`Get-ChildItem -LiteralPath $p.home -Force | Remove-Item -Recurse -Force`, {
      home: HOME,
    });
    await inherit("tar.exe", ["-C", win.dirname(HOME), "-xzf", "-"]);
  },
};
