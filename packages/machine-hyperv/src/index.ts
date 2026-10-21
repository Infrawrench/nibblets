import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  HYPERV_AGENT_PORT,
  hypervServiceId,
  type GuestImage,
  type GuestOs,
} from "@nibblets/protocol";
import {
  linuxDiskFile,
  type HostContext,
  type HypervisorPlugin,
  type ImageJob,
  type VmRef,
  type VmSpec,
} from "@nibblets/machine/host";
import { z } from "zod";
import { ConsoleRecorder, consoleTail } from "./console.ts";
import { connectHvSock, hvsockHelper } from "./hvsock.ts";
import { meta } from "./meta.ts";
import { powershell, psJson, type PowerShell } from "./powershell.ts";
import { installWindows } from "./windows.ts";

/** How big a VM's disks may grow: the system disk (differencing, on its image), and its home. */
const SYSTEM_GB = 32;
const HOME_GB = 64;

/**
 * The switch its VMs go out through, unless it's told another: the one every
 * Windows 10 and 11 with Hyper-V has, which NATs them out to the host's
 * network. Windows Server has none, so there it's one of the host's own.
 */
export const DEFAULT_SWITCH = "Default Switch";

const vmName = (id: string) => `nibblet-${id}`;

/** COM1 is the console's; the agent's is a Hyper-V socket (AGENT_SERVICE). */
const consolePipe = (id: string) => `\\\\.\\pipe\\nibblet-${id}-console`;

const files = (vm: VmRef) => ({
  system: join(vm.dir, "system.vhdx"),
  home: join(vm.dir, "home.vhdx"),
});

/**
 * The agent's Hyper-V socket, for Linux and Windows guests alike: the
 * service id Hyper-V gives a Linux guest's vsock port, which a Windows
 * guest listens on by that id. A COM port is slow, and loses what comes in.
 */
const AGENT_SERVICE = hypervServiceId(HYPERV_AGENT_PORT);

const DETECT = `
$cmd = Get-Command Get-VM -ErrorAction SilentlyContinue
if (-not $cmd) { @{ ok = $false; detail = 'Hyper-V isn''t turned on (Windows Features, then restart)' } | ConvertTo-Json -Compress; exit }
try { $host_ = Get-VMHost } catch {
  @{ ok = $false; detail = 'You need to be in the Hyper-V Administrators group to run VMs' } | ConvertTo-Json -Compress; exit
}
$switch = Get-VMSwitch -Name $p.switch -ErrorAction SilentlyContinue
if (-not $switch) { @{ ok = $false; detail = "There's no Hyper-V switch called '$($p.switch)' for VMs to reach the internet through" } | ConvertTo-Json -Compress; exit }
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
# Hyper-V lets a VM and the host talk over a socket for a service it knows of.
# HKLM wants an administrator: without one, it may be registered already.
try {
  $key = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices\\$($p.service)"
  if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name ElementName -Value 'Nibblets agent' -PropertyType String -Force | Out-Null
  }
} catch {}
Start-VM -VM $vm
@{ ok = $true } | ConvertTo-Json -Compress
`;

/** A VM's id, which a Hyper-V socket is addressed to. */
const VM_ID = `
@{ id = (Get-VM -Name $p.name -ErrorAction Stop).Id.Guid } | ConvertTo-Json -Compress
`;
const VmId = z.object({ id: z.uuid() });

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
 * The agent's port is a Hyper-V socket, which the guest listens on (a
 * relay in it, Python's for Linux and nibblet-hvsock.exe for Windows), and
 * the bridge connects to through a helper it builds (hvsock.ts).
 */
export class HyperV implements HypervisorPlugin {
  readonly id = meta.id;
  readonly name = meta.name;
  readonly diskFormat: "vhdx" = "vhdx";
  private readonly ps: PowerShell;
  private readonly switchName: string;
  private readonly consoles = new ConsoleRecorder((vm) => this.running(null, vm));

  constructor(opts: { powershell?: PowerShell; switch?: string } = {}) {
    this.ps = opts.powershell ?? powershell;
    this.switchName = opts.switch ?? DEFAULT_SWITCH;
  }

  async detect(_ctx: HostContext) {
    if (process.platform !== "win32")
      return { available: false, detail: "Only on Windows", guests: [] };
    const found = await this.host();
    if (!found.ok) return { available: false, detail: found.detail, guests: [] };
    const guests: GuestOs[] = ["linux", "windows"];
    return { available: true, detail: null, guests };
  }

  imageSource(guest: GuestOs): GuestImage["source"] {
    return guest === "windows" ? "windows-iso" : "none";
  }

  async prepareImage(_ctx: HostContext, guest: GuestOs, job: ImageJob): Promise<void> {
    if (guest !== "windows") throw new Error(`Hyper-V doesn't make ${guest} images itself`);
    await installWindows(this.ps, job, this.switchName);
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
      switch: this.switchName,
      console: consolePipe(vm.id),
      service: AGENT_SERVICE,
    });
    this.consoles.record(vm, consolePipe(vm.id));
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

  async running(_ctx: HostContext | null, vm: VmRef): Promise<boolean> {
    const state = (await this.vmStates())[vmName(vm.id)];
    return state === "Running" || state === "Starting";
  }

  async stop(_ctx: HostContext, vm: VmRef, force: boolean): Promise<void> {
    this.states = null;
    await psJson(this.ps, Ok, STOP, { name: vmName(vm.id), force });
  }

  async remove(_ctx: HostContext, vm: VmRef): Promise<void> {
    this.consoles.stop(vm.id);
    await psJson(this.ps, Ok, REMOVE, { name: vmName(vm.id) });
  }

  /** Its agent's port: a Hyper-V socket, through the helper. */
  async connect(ctx: HostContext, vm: VmRef): Promise<Duplex> {
    // One started before the bridge was, too.
    this.consoles.record(vm, consolePipe(vm.id));
    const [helper, { id }] = await Promise.all([
      hvsockHelper(join(ctx.dir, "bin")),
      psJson(this.ps, VmId, VM_ID, { name: vmName(vm.id) }),
    ]);
    return connectHvSock(helper, id, AGENT_SERVICE);
  }

  /** What its guest said on COM1, as recorded: Hyper-V keeps none of it. */
  async console(_ctx: HostContext, vm: VmRef): Promise<string> {
    return consoleTail(vm);
  }

  async capacity() {
    const found = await this.host();
    return found.ok ? { cpus: found.cpus, memoryMb: found.memoryMb } : null;
  }

  /** Whether it can run VMs here, through its switch, and what it has to give them. */
  private host() {
    return psJson(this.ps, Detect, DETECT, { switch: this.switchName });
  }
}
