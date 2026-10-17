import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeIso, windowsSetupFiles, type ImageJob } from "@nibblet/machine/host";
import { z } from "zod";
import { psJson, type PowerShell } from "./powershell.ts";

/** How long Windows gets to install itself and the runner, which is mostly downloading. */
const INSTALL_HOURS = 3;

/**
 * An installer VM: the user's Windows ISO first to boot, the setup disc
 * beside it, and a disk that becomes the image. Windows' boot loader asks
 * for a key before it boots from a DVD, so it's given Enter, through
 * Hyper-V's own keyboard, for as long as it might be asking.
 */
const INSTALL = `
$vm = New-VM -Name $p.name -Generation 2 -MemoryStartupBytes 4GB -NoVHD -Path $p.dir -SwitchName $p.switch
Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -CheckpointType Disabled
Set-VMProcessor -VM $vm -Count 2
New-VHD -Path $p.disk -SizeBytes 64GB -Dynamic | Out-Null
Add-VMHardDiskDrive -VM $vm -Path $p.disk
$dvd = Add-VMDvdDrive -VM $vm -Path $p.iso -Passthru
Add-VMDvdDrive -VM $vm -Path $p.setup
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice $dvd
Start-VM -VM $vm
$keyboard = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_Keyboard | Where-Object SystemName -eq "$($vm.Id)"
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  Invoke-CimMethod -InputObject $keyboard -MethodName TypeKey -Arguments @{ keyCode = 13 } | Out-Null
}
@{ ok = $true } | ConvertTo-Json -Compress
`;

const STATE = `
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
@{ state = if ($vm) { [string]$vm.State } else { 'Missing' } } | ConvertTo-Json -Compress
`;

/** Done: the installer VM goes, and its disk stays, as the image. */
const FINISH = `
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($vm) {
  if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
  Get-VMDvdDrive -VM $vm | Remove-VMDvdDrive
  Remove-VM -VM $vm -Force
}
@{ ok = $true } | ConvertTo-Json -Compress
`;

const Ok = z.object({ ok: z.literal(true) });
const State = z.object({ state: z.string() });

export async function installWindows(
  ps: PowerShell,
  job: ImageJob,
  switchName: string,
): Promise<void> {
  if (!job.source || !existsSync(job.source)) {
    throw new Error("Give the path to a Windows ISO on this computer");
  }
  const setup = join(job.dir, "setup.iso");
  await writeFile(
    setup,
    makeIso(
      "NIBBLETSETUP",
      windowsSetupFiles({
        repo: job.repo,
        ref: job.version ? `v${job.version}` : "main",
        arch: process.arch === "arm64" ? "arm64" : "amd64",
      }),
    ),
  );
  const name = `nibblet-image-${Date.now().toString(36)}`;
  const params = {
    name,
    dir: job.dir,
    disk: join(job.dir, "disk.vhdx"),
    iso: job.source,
    setup,
    switch: switchName,
  };
  job.progress(null, "Starting Windows' installer");
  await psJson(ps, Ok, INSTALL, params);
  const started = Date.now();
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 15_000));
      const { state } = await psJson(ps, State, STATE, { name });
      if (state === "Off") break;
      const minutes = Math.round((Date.now() - started) / 60_000);
      if (minutes > INSTALL_HOURS * 60) throw new Error("Windows took too long to install");
      job.progress(null, `Installing Windows and the runner (${minutes} minutes so far)`);
    }
  } finally {
    await psJson(ps, Ok, FINISH, { name }).catch(() => undefined);
  }
}
