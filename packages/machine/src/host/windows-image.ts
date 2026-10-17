import { randomBytes } from "node:crypto";
import type { IsoFile } from "./iso.ts";

/**
 * A Windows guest's image, made from the user's own installer: Windows
 * setup reads its answers from a second disc (SETUP_LABEL), which wipes the
 * disk, installs Windows without asking anything, and at `specialize` runs
 * setup.ps1. That puts bootstrap.ps1 on C: and has it run at every startup
 * as SYSTEM: it installs Node and this release's runner (and builds the two
 * helpers in machine/windows), then runs the guest agent. The first time,
 * while the image is being made, it shuts down instead, which is how the
 * hypervisor plugin knows the image is done.
 */

export const SETUP_LABEL = "NIBBLETSETUP";

/**
 * How far making the image has got, as setup and the bootstrap say it on
 * COM1: lines that start with this. A hypervisor that records COM1 while it
 * installs can show them as progress, and say where it stopped if it does.
 */
export const INSTALL_SAYS = "nibblets: ";
/** The last thing it says, once the runner is in: then it shuts down. */
export const INSTALL_DONE = "Done: shutting down to finish its image";

/** The last thing setup or the bootstrap said, from what COM1 recorded. */
export function installSaid(recorded: string): string | null {
  const lines = recorded
    .split(/\r?\n/)
    .filter((l) => l.startsWith(INSTALL_SAYS))
    .map((l) => l.slice(INSTALL_SAYS.length).trim());
  return lines.at(-1) ?? null;
}

/** PowerShell for saying how far it's got on COM1; nothing hears it once the image is made. */
const SAY_PS1 = `function Say($what) {
  try {
    $port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
    $port.WriteTimeout = 2000
    $port.Open()
    $port.WriteLine("${INSTALL_SAYS}$what")
    $port.Close()
  } catch {}
}`;

/** What to install and where from: a release of this repository. */
export interface WindowsSetup {
  /** `owner/repo` on GitHub. */
  repo: string;
  /** A tag or branch: `v0.4.0`. */
  ref: string;
  arch: "amd64" | "arm64";
  /** Which edition in the installer, by its index; 1 is the first. */
  imageIndex?: number;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function autounattend(setup: WindowsSetup, adminPassword: string): string {
  const component = (name: string, body: string) =>
    `    <component name="${name}" processorArchitecture="${setup.arch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">\n${body}\n    </component>`;
  // Windows 11's setup wants a TPM and Secure Boot; the VM has neither to show it while it installs.
  const bypass = ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassCPUCheck"]
    .map(
      (key, i) =>
        `          <RunSynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${key} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>`,
    )
    .join("\n");
  const setupPs = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "&amp; ((Get-Volume -FileSystemLabel ${SETUP_LABEL}).DriveLetter + ':\\SETUP.PS1')"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
${component(
  "Microsoft-Windows-International-Core-WinPE",
  `      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>`,
)}
${component(
  "Microsoft-Windows-Setup",
  `      <RunSynchronous>
${bypass}
      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${setup.imageIndex ?? 1}</Value></MetaData></InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>`,
)}
  </settings>
  <settings pass="specialize">
${component(
  "Microsoft-Windows-Shell-Setup",
  `      <ComputerName>nibblet</ComputerName>
      <TimeZone>UTC</TimeZone>`,
)}
${component(
  "Microsoft-Windows-Deployment",
  `      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>${setupPs}</Path></RunSynchronousCommand>
      </RunSynchronous>`,
)}
  </settings>
  <settings pass="oobeSystem">
${component(
  "Microsoft-Windows-Shell-Setup",
  `      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>nibbletadmin</Name>
            <Group>Administrators</Group>
            <Password><Value>${xml(adminPassword)}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>`,
)}
  </settings>
</unattend>
`;
}

/** At `specialize`: the bootstrap onto C:, and a task to run it at every startup, as SYSTEM. */
export const SETUP_PS1 = `$ErrorActionPreference = 'Stop'
${SAY_PS1}
trap { Say "Setting up its bootstrap failed: $($_.Exception.Message)"; break }
Say 'Setting up its bootstrap'
$media = (Get-Volume -FileSystemLabel ${SETUP_LABEL}).DriveLetter + ':\\'
New-Item -ItemType Directory -Force -Path C:\\Nibblets | Out-Null
Copy-Item ($media + 'BOOTSTRAP.PS1') C:\\Nibblets\\bootstrap.ps1
Copy-Item ($media + 'INSTALL.JSON') C:\\Nibblets\\install.json
# The first startup makes the image: the bootstrap installs, then shuts down.
New-Item -ItemType File -Force -Path C:\\Nibblets\\preparing | Out-Null
# Only SYSTEM and Administrators: the agent's user mustn't change what runs as SYSTEM.
icacls C:\\Nibblets /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\\Nibblets\\bootstrap.ps1'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Nibblets agent' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Say 'Finishing Windows setup'
`;

/**
 * At every startup: Node and the runner, once (again for a new release),
 * then the guest agent; or, the first time, shutting down to say the image
 * is made. The Windows Update service is left alone: it's the user's machine.
 */
export const BOOTSTRAP_PS1 = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\\Nibblets'
$log = "$root\\bootstrap.log"
Start-Transcript -Path $log -Append | Out-Null
${SAY_PS1}
trap { Say "Its bootstrap failed: $($_.Exception.Message)"; break }
$install = Get-Content "$root\\install.json" -Raw | ConvertFrom-Json
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Download($url, $to) {
  for ($i = 1; $i -le 5; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $to; return } catch { Start-Sleep -Seconds (5 * $i) }
  }
  throw "Couldn't download $url"
}

if (-not (Test-Path "$root\\node\\node.exe")) {
  Say 'Installing Node.js'
  $base = 'https://nodejs.org/dist/latest-v24.x'
  Get-Download "$base/SHASUMS256.txt" "$root\\node-sums.txt"
  $line = Get-Content "$root\\node-sums.txt" | Where-Object { $_ -match "node-v24\\.[0-9.]+-win-$arch\\.zip$" } | Select-Object -First 1
  $hash, $file = $line -split '\\s+'
  Get-Download "$base/$file" "$root\\node.zip"
  if ((Get-FileHash "$root\\node.zip" -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'Node.js did not match its checksum' }
  Expand-Archive "$root\\node.zip" "$root\\node-unpacked" -Force
  Move-Item (Get-ChildItem "$root\\node-unpacked" | Select-Object -First 1).FullName "$root\\node"
  Remove-Item -Recurse -Force "$root\\node-unpacked", "$root\\node.zip", "$root\\node-sums.txt"
}

$want = "$($install.repo)@$($install.ref)"
$have = if (Test-Path "$root\\app\\.nibblets") { Get-Content "$root\\app\\.nibblets" -Raw } else { '' }
if ($have.Trim() -ne $want) {
  Say "Downloading the runner ($want)"
  Get-Download "https://github.com/$($install.repo)/archive/$($install.ref).zip" "$root\\app.zip"
  if (Test-Path "$root\\app-unpacked") { Remove-Item -Recurse -Force "$root\\app-unpacked" }
  Expand-Archive "$root\\app.zip" "$root\\app-unpacked" -Force
  if (Test-Path "$root\\app") { Remove-Item -Recurse -Force "$root\\app" }
  Move-Item (Get-ChildItem "$root\\app-unpacked" | Select-Object -First 1).FullName "$root\\app"
  Remove-Item -Recurse -Force "$root\\app-unpacked", "$root\\app.zip"
  $env:Path = "$root\\node;$env:Path"
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  Push-Location "$root\\app"
  Say "Installing the runner's packages"
  & "$root\\node\\corepack.cmd" pnpm install --prod --frozen-lockfile --filter '@nibblet/runner...'
  if ($LASTEXITCODE -ne 0) { throw 'Installing the runner failed' }
  Pop-Location
  Say 'Building its helpers'
  New-Item -ItemType Directory -Force -Path "$root\\bin" | Out-Null
  foreach ($helper in 'runas', 'serial') {
    $source = Get-Content "$root\\app\\apps\\runner\\src\\machine\\windows\\$helper.cs" -Raw
    $out = "$root\\bin\\nibblet-$helper.exe"
    if (Test-Path $out) { Remove-Item -Force $out }
    Add-Type -TypeDefinition $source -OutputAssembly $out -OutputType ConsoleApplication
  }
  Set-Content "$root\\app\\.nibblets" $want
}

if (Test-Path "$root\\preparing") {
  Remove-Item -Force "$root\\preparing"
  Say '${INSTALL_DONE}'
  Stop-Transcript | Out-Null
  Stop-Computer -Force
  exit 0
}

Stop-Transcript | Out-Null
& "$root\\node\\node.exe" "$root\\app\\apps\\runner\\src\\machine\\agent.ts"
exit $LASTEXITCODE
`;

/** The setup disc's files: setup's answers, and what it puts on C:. */
export function windowsSetupFiles(setup: WindowsSetup): IsoFile[] {
  const encoder = new TextEncoder();
  // Nobody signs in as it; Windows just wants an administrator to exist.
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  return [
    { name: "AUTOUNATTEND.XML", data: encoder.encode(autounattend(setup, password)) },
    { name: "SETUP.PS1", data: encoder.encode(SETUP_PS1) },
    { name: "BOOTSTRAP.PS1", data: encoder.encode(BOOTSTRAP_PS1) },
    {
      name: "INSTALL.JSON",
      data: encoder.encode(JSON.stringify({ repo: setup.repo, ref: setup.ref })),
    },
  ];
}
