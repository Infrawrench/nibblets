import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { GuestImage, GuestOs } from "@nibblet/protocol";
import {
  connectTo,
  linuxDiskFile,
  type HostContext,
  type HypervisorPlugin,
  type ImageJob,
  type VmRef,
  type VmSpec,
} from "@nibblet/machine/host";
import { z } from "zod";
import { meta } from "./meta.ts";
import { powershell, psJson, type PowerShell } from "./powershell.ts";
import { installWindows } from "./windows.ts";

/** How big a VM's disks may grow: the system disk (differencing, on its image), and its home. */
const SYSTEM_GB = 32;
const HOME_GB = 64;

/** The switch every Windows with Hyper-V has, which NATs its VMs out to the host's network. */
const SWITCH = "Default Switch";

const vmName = (id: string) => `nibblet-${id}`;

/** COM2 is the agent's (the guest's ttyS1); COM1 is the console's. */
const agentPipe = (id: string) => `\\\\.\\pipe\\nibblet-${id}-agent`;
const consolePipe = (id: string) => `\\\\.\\pipe\\nibblet-${id}-console`;

const files = (vm: VmRef) => ({
  system: join(vm.dir, "system.vhdx"),
  home: join(vm.dir, "home.vhdx"),
});

const DETECT = `
$cmd = Get-Command Get-VM -ErrorAction SilentlyContinue
if (-not $cmd) { @{ ok = $false; detail = 'Hyper-V isn''t turned on (Windows Features, then restart)' } | ConvertTo-Json -Compress; exit }
try { $host_ = Get-VMHost } catch {
  @{ ok = $false; detail = 'You need to be in the Hyper-V Administrators group to run VMs' } | ConvertTo-Json -Compress; exit
}
$switch = Get-VMSwitch -Name '${SWITCH}' -ErrorAction SilentlyContinue
if (-not $switch) { @{ ok = $false; detail = 'There''s no Default Switch for VMs to reach the internet through' } | ConvertTo-Json -Compress; exit }
@{ ok = $true; cpus = $host_.LogicalProcessorCount; memoryMb = [int]($host_.MemoryCapacity / 1MB) } | ConvertTo-Json -Compress
`;
const Detect = z.union([
  z.object({ ok: z.literal(false), detail: z.string() }),
  z.object({ ok: z.literal(true), cpus: z.int(), memoryMb: z.int() }),
]);

/**
 * Makes the VM, or brings one made before up to date, and boots it. Its
 * system disk is a differencing disk on the image (only what the guest
 * changes is written to it), grown, as its guest grows its root to fill.
 */
const START = `
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($p.fresh -or -not (Test-Path $p.system)) {
  if ($vm) { Get-VMHardDiskDrive -VM $vm | Remove-VMHardDiskDrive }
  Remove-Item -LiteralPath $p.system -ErrorAction SilentlyContinue
  New-VHD -Path $p.system -ParentPath $p.base -Differencing | Out-Null
  $size = [uint64]$p.systemGb * 1GB
  if ((Get-VHD -Path $p.system).Size -lt $size) { Resize-VHD -Path $p.system -SizeBytes $size }
}
if (-not (Test-Path $p.home)) { New-VHD -Path $p.home -SizeBytes ([uint64]$p.homeGb * 1GB) -Dynamic | Out-Null }
if (-not $vm) {
  $vm = New-VM -Name $p.name -Generation 2 -MemoryStartupBytes ([int64]$p.memoryMb * 1MB) -NoVHD -Path $p.dir -SwitchName $p.switch
  Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -CheckpointType Disabled -AutomaticStopAction ShutDown -AutomaticStartAction Nothing
  Set-VMComPort -VM $vm -Number 1 -Path $p.console
  Set-VMComPort -VM $vm -Number 2 -Path $p.agent
}
if (-not (Get-VMHardDiskDrive -VM $vm)) {
  Add-VMHardDiskDrive -VM $vm -Path $p.system
  Add-VMHardDiskDrive -VM $vm -Path $p.home
}
# Linux's boot loader isn't signed with Microsoft's key.
if ($p.guest -eq 'linux') { Set-VMFirmware -VM $vm -EnableSecureBoot Off }
else { Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows }
Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1)
Set-VMProcessor -VM $vm -Count $p.cpus
Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ([int64]$p.memoryMb * 1MB)
Start-VM -VM $vm
@{ ok = $true } | ConvertTo-Json -Compress
`;

/** Every nibblet's VM and how it is, in one go: PowerShell is slow to start. */
const STATES = `
$states = @{}
Get-VM -Name 'nibblet-*' -ErrorAction SilentlyContinue | ForEach-Object { $states[$_.Name] = [string]$_.State }
$states | ConvertTo-Json -Compress
`;
const States = z.record(z.string(), z.string());

/** Shutting down through the guest's own integration service, or turning it off. */
const STOP = `
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($vm -and $vm.State -ne 'Off') {
  if ($p.force) { Stop-VM -VM $vm -TurnOff -Force } else { Stop-VM -VM $vm -Force -AsJob | Out-Null }
}
@{ ok = $true } | ConvertTo-Json -Compress
`;

const REMOVE = `
$vm = Get-VM -Name $p.name -ErrorAction SilentlyContinue
if ($vm) {
  if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
  Remove-VM -VM $vm -Force
}
@{ ok = $true } | ConvertTo-Json -Compress
`;

const Ok = z.object({ ok: z.literal(true) });

/**
 * Hyper-V, on Windows: Linux guests from the runner image, made in VHDX.
 * Its cmdlets need an administrator, or the Hyper-V Administrators group.
 * The agent's port is COM2, as a named pipe Hyper-V serves; it's slower
 * than a virtio port, so the browser's view and snapshots are slower than
 * on other hypervisors.
 */
export class HyperV implements HypervisorPlugin {
  readonly id = meta.id;
  readonly name = meta.name;
  readonly diskFormat: "vhdx" = "vhdx";
  private readonly ps: PowerShell;

  constructor(opts: { powershell?: PowerShell } = {}) {
    this.ps = opts.powershell ?? powershell;
  }

  async detect(_ctx: HostContext) {
    if (process.platform !== "win32")
      return { available: false, detail: "Only on Windows", guests: [] };
    const found = await psJson(this.ps, Detect, DETECT, {});
    if (!found.ok) return { available: false, detail: found.detail, guests: [] };
    const guests: GuestOs[] = ["linux", "windows"];
    return { available: true, detail: null, guests };
  }

  imageSource(guest: GuestOs): GuestImage["source"] {
    return guest === "windows" ? "windows-iso" : "none";
  }

  async prepareImage(_ctx: HostContext, guest: GuestOs, job: ImageJob): Promise<void> {
    if (guest !== "windows") throw new Error(`Hyper-V doesn't make ${guest} images itself`);
    await installWindows(this.ps, job, SWITCH);
  }

  async start(_ctx: HostContext, vm: VmSpec): Promise<void> {
    await mkdir(vm.dir, { recursive: true });
    const f = files(vm);
    const base = join(vm.imageDir, vm.guest === "linux" ? linuxDiskFile("vhdx") : "disk.vhdx");
    if ((vm.fresh || !existsSync(f.system)) && !existsSync(base)) {
      throw new Error(`There's no image at ${base}`);
    }
    this.states = null;
    await psJson(this.ps, Ok, START, {
      name: vmName(vm.id),
      dir: vm.dir,
      guest: vm.guest,
      fresh: vm.fresh,
      system: f.system,
      home: f.home,
      base,
      systemGb: SYSTEM_GB,
      homeGb: HOME_GB,
      cpus: vm.cpus,
      memoryMb: vm.memoryMb,
      switch: SWITCH,
      agent: agentPipe(vm.id),
      console: consolePipe(vm.id),
    });
  }

  private states: { at: number; states: Promise<Record<string, string>> } | null = null;

  /** Every nibblet VM's state, asked at most every couple of seconds. */
  private vmStates(): Promise<Record<string, string>> {
    if (!this.states || Date.now() - this.states.at > 2000) {
      const states = psJson(this.ps, States, STATES, {});
      this.states = { at: Date.now(), states };
      // Asked again next time, rather than kept as an answer.
      states.catch(() => {
        if (this.states?.states === states) this.states = null;
      });
    }
    return this.states.states;
  }

  async running(_ctx: HostContext, vm: VmRef): Promise<boolean> {
    const state = (await this.vmStates())[vmName(vm.id)];
    return state === "Running" || state === "Starting";
  }

  async stop(_ctx: HostContext, vm: VmRef, force: boolean): Promise<void> {
    this.states = null;
    await psJson(this.ps, Ok, STOP, { name: vmName(vm.id), force });
  }

  async remove(_ctx: HostContext, vm: VmRef): Promise<void> {
    await psJson(this.ps, Ok, REMOVE, { name: vmName(vm.id) });
  }

  connect(_ctx: HostContext, vm: VmRef): Promise<Duplex> {
    return connectTo(agentPipe(vm.id));
  }

  /** Hyper-V keeps no console of its own, and nothing reads COM1 for it; the agent's runs say more. */
  async console(): Promise<string> {
    return "";
  }

  async capacity() {
    const found = await psJson(this.ps, Detect, DETECT, {});
    return found.ok ? { cpus: found.cpus, memoryMb: found.memoryMb } : null;
  }
}
