import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withHosts } from "./macos.ts";
import { entryArgv, relayStream, type GuestPlugin } from "./guest.ts";

const run = promisify(execFile);
const HOME = "C:\\Users\\nibblet";
const HOME_LABEL = "nibblet-home";
/** Built by the guest's bootstrap from machine/windows/serial.cs; its stdio is the port. */
export const SERIAL_RELAY = "C:\\Nibblets\\bin\\nibblet-serial.exe";
const HOSTS = "C:\\Windows\\System32\\drivers\\etc\\hosts";
const ENTRY = fileURLToPath(new URL("../entry.ts", import.meta.url));

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
    {
      env: { ...process.env, NIBBLET_PS: JSON.stringify(params) },
      windowsHide: true,
      timeout: 300_000,
    },
  );
  return stdout;
}

/**
 * The home disk: made the first time from the disk that's still raw, NTFS,
 * and mounted (each boot) at the agent's home folder rather than a letter.
 * C: is grown to fill its own disk, which is made bigger than its image.
 */
const PREPARE = `
$part = Get-Partition -DriveLetter C
$max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax
if ($part.Size -lt $max - 1MB) { Resize-Partition -DriveLetter C -Size $max }

$vol = Get-Volume -FileSystemLabel $p.label -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $vol) {
  $disk = Get-Disk | Where-Object PartitionStyle -eq 'RAW' | Select-Object -First 1
  if (-not $disk) { throw "There's no disk for its home" }
  Initialize-Disk -Number $disk.Number -PartitionStyle GPT
  $new = New-Partition -DiskNumber $disk.Number -UseMaximumSize
  Format-Volume -Partition $new -FileSystem NTFS -NewFileSystemLabel $p.label -Confirm:$false | Out-Null
  $vol = Get-Volume -FileSystemLabel $p.label
  Write-Output 'made'
}
$partition = Get-Partition | Where-Object { (Get-Volume -Partition $_ -ErrorAction SilentlyContinue).UniqueId -eq $vol.UniqueId }
if (-not ($partition.AccessPaths -contains ($p.home + '\\'))) {
  New-Item -ItemType Directory -Force -Path $p.home | Out-Null
  Add-PartitionAccessPath -InputObject $partition -AccessPath $p.home
}
`;

export const windows: GuestPlugin = {
  os: "windows",

  async prepare(log) {
    const said = await ps(PREPARE, { label: HOME_LABEL, home: HOME });
    if (said.includes("made")) log("made its home disk");
    const gateway = await ps(
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop",
    ).then(
      (out) => out.trim() || null,
      () => null,
    );
    const hosts = await readFile(HOSTS, "utf8").catch(() => "");
    await writeFile(HOSTS, withHosts(hosts.replace(/\r\n/g, "\n"), gateway).replace(/\n/g, "\r\n"));
  },

  async openPort(log) {
    log("talking to the host on COM2");
    return relayStream(SERIAL_RELAY, ["COM2"]);
  },

  entry(command, args) {
    return { file: process.execPath, argv: [ENTRY, ...entryArgv(command, args)] };
  },

  async poweroff() {
    await run("shutdown", ["/s", "/t", "0"]);
  },
};
