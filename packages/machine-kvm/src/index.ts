import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  constants,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { GUEST_PORT_NAME, type GuestImage, type GuestOs } from "@nibblet/protocol";
import { z } from "zod";
import { ask, qmp } from "./qmp.ts";
import { litFraction } from "./screen.ts";
import {
  alive,
  connectTo,
  INSTALL_DONE,
  INSTALL_FAILED,
  installSaid,
  installSayings,
  linuxDiskFile,
  livePid,
  makeIso,
  randomMac,
  sleep,
  socketPath,
  tailFile,
  windowsSetupFiles,
  type HostContext,
  type HypervisorPlugin,
  type ImageJob,
  type VmRef,
  type VmSpec,
} from "@nibblet/machine/host";
import { meta } from "./meta.ts";

const run = promisify(execFile);

/** How big a VM's disks may grow: the system disk (an overlay on its image), and its home. */
const SYSTEM_GB = 32;
const HOME_GB = 64;
const WINDOWS_DISK_GB = 64;
/** How long Windows gets to install itself and the runner, which is mostly downloading. */
const INSTALL_HOURS = 3;
/**
 * Once it's said something, how long it may go without saying more: it says
 * each step, and says it's still compiling. Between setup's last word and
 * the bootstrap's first are Windows' own first-run steps, which say nothing,
 * and on a slow host have taken over 15 minutes.
 */
const INSTALL_QUIET_MINUTES = 30;
/**
 * How long setup may take to get as far as saying anything while its screen
 * is dark: it hasn't started from its installer. Once setup's own screens are
 * up it has the whole install's time, since a slow host can take an hour or
 * more just to copy Windows.
 */
const INSTALL_FIRST_WORD_MINUTES = 30;
/** How long Windows has to stop once its install is done, before it's asked, and then made. */
const DONE_GRACE_MS = 3 * 60_000;

const x86 = process.arch !== "arm64";

export type Accel = "kvm" | "tcg";

/**
 * QEMU's name for this machine's architecture, and the machine type it
 * boots. With KVM, the host's own CPU; with TCG (QEMU's own, for testing
 * where there's no KVM), the most QEMU can be.
 */
function arch(accel: Accel) {
  const cpu = accel === "kvm" ? "host" : "max";
  return x86
    ? { qemu: "qemu-system-x86_64", machine: `q35,accel=${accel}`, cpu }
    : {
        qemu: "qemu-system-aarch64",
        machine: `virt,accel=${accel}${accel === "kvm" ? ",gic-version=host" : ""}`,
        cpu,
      };
}

/**
 * UEFI firmware, as distributions package it: the code, read-only, and a
 * template for each VM's own variables. Without Secure Boot: neither Linux's
 * loader nor the guests need it.
 */
const FIRMWARE = x86
  ? [
      ["/usr/share/OVMF/OVMF_CODE_4M.fd", "/usr/share/OVMF/OVMF_VARS_4M.fd"],
      ["/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_VARS.fd"],
      ["/usr/share/edk2/ovmf/OVMF_CODE.fd", "/usr/share/edk2/ovmf/OVMF_VARS.fd"],
      ["/usr/share/edk2/x64/OVMF_CODE.4m.fd", "/usr/share/edk2/x64/OVMF_VARS.4m.fd"],
      ["/usr/share/qemu/ovmf-x86_64-code.bin", "/usr/share/qemu/ovmf-x86_64-vars.bin"],
    ]
  : [
      ["/usr/share/AAVMF/AAVMF_CODE.fd", "/usr/share/AAVMF/AAVMF_VARS.fd"],
      [
        "/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw",
        "/usr/share/edk2/aarch64/vars-template-pflash.raw",
      ],
      ["/usr/share/qemu/aavmf-aarch64-code.bin", "/usr/share/qemu/aavmf-aarch64-vars.bin"],
    ];

export function firmware(): { code: string; vars: string } | null {
  for (const [code, vars] of FIRMWARE) {
    if (code && vars && existsSync(code) && existsSync(vars)) return { code, vars };
  }
  return null;
}

const files = (vm: VmRef) => ({
  system: join(vm.dir, "system.qcow2"),
  home: join(vm.dir, "home.qcow2"),
  vars: join(vm.dir, "efi-vars.fd"),
  mac: join(vm.dir, "mac"),
  pid: join(vm.dir, "qemu.pid"),
  console: join(vm.dir, "console.log"),
  /** QEMU's own output: why it stopped, if it did by itself. */
  qemuLog: join(vm.dir, "qemu.log"),
  /** Its screen, when it was last asked for. */
  screen: join(vm.dir, "screen.png"),
  agent: socketPath("kvm", vm.id, "agent"),
  qmp: socketPath("kvm", vm.id, "qmp"),
});

/**
 * The devices a guest has. Linux's are virtio, with the agent's port a
 * named virtio serial port; Windows has no drivers for virtio until
 * someone installs them, so it gets AHCI disks, an e1000e network card,
 * and COM2 for the agent's port. Neither network card has a boot ROM:
 * nothing boots from the network, and the ROMs are packaged apart. Both
 * have the console on a virtio
 * console (hvc0), to a file, and user-mode networking, where the host is
 * 10.0.2.2 and nothing on the host's own networks is in the way.
 */
export function deviceArgs(
  guest: GuestOs,
  disks: { system: string; home: string },
  ports: { agent: string; console: string },
  mac: string,
): string[] {
  const common = [
    "-device",
    "virtio-rng-pci",
    "-device",
    "virtio-serial-pci",
    "-chardev",
    `file,id=console,path=${ports.console}`,
    "-device",
    "virtconsole,chardev=console",
    "-chardev",
    `socket,id=agent,path=${ports.agent},server=on,wait=off`,
  ];
  if (guest === "windows") {
    return [
      ...common,
      "-device",
      "ahci,id=ahci",
      "-drive",
      `if=none,id=system,file=${disks.system},format=qcow2,discard=unmap`,
      "-device",
      "ide-hd,drive=system,bus=ahci.0,bootindex=0",
      "-drive",
      `if=none,id=home,file=${disks.home},format=qcow2,discard=unmap`,
      "-device",
      "ide-hd,drive=home,bus=ahci.1",
      "-netdev",
      "user,id=net0",
      "-device",
      `e1000e,netdev=net0,mac=${mac},romfile=`,
      "-device",
      "isa-serial,chardev=agent,index=1",
    ];
  }
  return [
    ...common,
    "-drive",
    `file=${disks.system},if=virtio,format=qcow2,discard=unmap`,
    "-drive",
    `file=${disks.home},if=virtio,format=qcow2,discard=unmap`,
    "-netdev",
    "user,id=net0",
    "-device",
    `virtio-net-pci,netdev=net0,mac=${mac},romfile=`,
    "-device",
    `virtserialport,chardev=agent,name=${GUEST_PORT_NAME}`,
  ];
}

/** What every VM here starts with: a name, its accelerator, the firmware, and nothing on screen. */
function baseArgs(
  accel: Accel,
  name: string,
  size: { cpus: number; memoryMb: number },
  fw: { code: string; vars: string },
  control: { qmp: string; pid: string },
): string[] {
  return [
    "-name",
    name,
    "-machine",
    arch(accel).machine,
    "-cpu",
    arch(accel).cpu,
    "-smp",
    String(size.cpus),
    "-m",
    String(size.memoryMb),
    "-drive",
    `if=pflash,format=raw,readonly=on,file=${fw.code}`,
    "-drive",
    `if=pflash,format=raw,file=${fw.vars}`,
    "-qmp",
    `unix:${control.qmp},server=on,wait=off`,
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    "none",
    "-msg",
    "timestamp=on",
    "-pidfile",
    control.pid,
  ];
}

/**
 * Starts QEMU in the background, on its own (so it outlives the bridge),
 * with what it says in `log`: a VM that stops by itself says why there.
 * Started once its control socket is up and it's still running a moment on.
 */
async function qemu(
  accel: Accel,
  args: string[],
  files: { qmp: string; log: string },
): Promise<void> {
  const log = await open(files.log, "a");
  const child = spawn(arch(accel).qemu, args, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  child.unref();
  let exited: string | null = null;
  child.once("exit", (code, signal) => (exited = signal ?? `code ${code ?? "?"}`));
  child.once("error", (err) => (exited = err.message));
  // Started once it says it's running, as daemonising did: its devices are
  // all there by then, so the agent's port opens once, not again as they come.
  const until = Date.now() + 60_000;
  for (;;) {
    if (exited !== null || Date.now() > until) {
      const said = (await tailFile(files.log, 2000)).trim();
      throw new Error(
        `QEMU didn't start (${exited ?? "it never said it was running"})${said ? `: ${said}` : ""}`,
      );
    }
    const status = existsSync(files.qmp)
      ? await ask(files.qmp, "query-status", Status).catch(() => null)
      : null;
    if (status?.running) return;
    await sleep(200);
  }
}

const Status = z.object({ running: z.boolean() });

/**
 * KVM, through QEMU, on Linux: Linux guests from the runner image (the
 * same disk as Apple's), and on x86 Windows guests from the user's
 * installer, each under a qcow2 overlay of its own. Each VM is a QEMU
 * of its own, detached so it outlives the bridge, with its agent's port on a
 * unix socket.
 */
export class Kvm implements HypervisorPlugin {
  readonly id = meta.id;
  readonly name = meta.name;
  readonly diskFormat: "raw" = "raw";
  private readonly accel: Accel;

  /** `accel`: TCG only for testing, or a machine without KVM, which it's far slower on. */
  constructor(opts: { accel?: Accel } = {}) {
    this.accel = opts.accel ?? "kvm";
  }

  async detect(_ctx: HostContext) {
    if (process.platform !== "linux")
      return { available: false, detail: "Only on Linux", guests: [] };
    const kvm = await (
      this.accel === "tcg" ? Promise.resolve() : access("/dev/kvm", constants.R_OK | constants.W_OK)
    ).then(
      () => null,
      () =>
        existsSync("/dev/kvm")
          ? "You're not in the kvm group, so can't use /dev/kvm (add yourself and log in again)"
          : "There's no /dev/kvm: this machine's CPU or its VM doesn't offer KVM",
    );
    if (kvm) return { available: false, detail: kvm, guests: [] };
    const tools: string[] = [arch(this.accel).qemu, "qemu-img"];
    for (const tool of tools) {
      const missing = await run(tool, ["--version"]).then(
        () => false,
        () => true,
      );
      if (missing) return { available: false, detail: `${tool} isn't installed`, guests: [] };
    }
    if (!firmware()) {
      return {
        available: false,
        detail: "There's no UEFI firmware for QEMU (OVMF or AAVMF)",
        guests: [],
      };
    }
    const guests: GuestOs[] = x86 ? ["linux", "windows"] : ["linux"];
    return { available: true, detail: null, guests };
  }

  imageSource(guest: GuestOs): GuestImage["source"] {
    return guest === "windows" ? "windows-iso" : "none";
  }

  /** Windows, installed by itself from the user's ISO and the setup disc. */
  async prepareImage(ctx: HostContext, guest: GuestOs, job: ImageJob): Promise<void> {
    if (guest !== "windows") throw new Error(`KVM doesn't make ${guest} images itself`);
    if (!job.source || !existsSync(job.source)) {
      throw new Error("Give the path to a Windows ISO on this computer");
    }
    const fw = firmware();
    if (!fw) throw new Error("There's no UEFI firmware for QEMU");
    const disk = join(job.dir, "disk.qcow2");
    const setup = join(job.dir, "setup.iso");
    const vars = join(job.dir, "efi-vars.fd");
    const control = { qmp: join(job.dir, "install-qmp.sock"), pid: join(job.dir, "install.pid") };
    // What setup and the bootstrap say on COM1, and the screen now and then:
    // kept beside the images, so they're there to see if it doesn't finish.
    const said = join(job.dir, "install-com1.log");
    const screen = join(ctx.dir, "windows-install.png");
    await writeFile(
      setup,
      makeIso(
        "NIBBLETSETUP",
        windowsSetupFiles({
          repo: job.repo,
          ref: job.ref,
          arch: "amd64",
        }),
      ),
    );
    await run("qemu-img", ["create", "-q", "-f", "qcow2", disk, `${WINDOWS_DISK_GB}G`]);
    await copyFile(fw.vars, vars);
    job.progress(null, "Starting Windows' installer");
    await qemu(
      this.accel,
      [
        ...baseArgs(
          this.accel,
          `nibblet-image-${Date.now().toString(36)}`,
          { cpus: 2, memoryMb: 4096 },
          { ...fw, vars },
          control,
        ),
        "-device",
        "ahci,id=ahci",
        "-drive",
        `if=none,id=disk,file=${disk},format=qcow2,discard=unmap`,
        "-device",
        "ide-hd,drive=disk,bus=ahci.0,bootindex=1",
        "-drive",
        `if=none,id=windows,file=${job.source},media=cdrom,readonly=on`,
        "-device",
        "ide-cd,drive=windows,bus=ahci.1,bootindex=0",
        "-drive",
        `if=none,id=setup,file=${setup},media=cdrom,readonly=on`,
        "-device",
        "ide-cd,drive=setup,bus=ahci.2",
        "-netdev",
        "user,id=net0",
        "-device",
        "e1000e,netdev=net0,romfile=",
        "-chardev",
        `file,id=said,path=${said}`,
        "-device",
        "isa-serial,chardev=said,index=0",
      ],
      { qmp: control.qmp, log: join(ctx.dir, "windows-install-qemu.log") },
    );
    const pid = await livePid(control.pid);
    // Windows' boot loader asks for a key before it boots from a DVD, for five
    // seconds, once the firmware gets there: on a busy host that can be a
    // while. So Enter, while the screen's dark (the prompt, then the logo while
    // setup loads, which ignores keys), and never again once setup's own screen
    // is up: Enter there is Cancel, and after a restart it would start setup over.
    const shot = join(job.dir, "boot-screen.ppm");
    const lit = () =>
      ask(control.qmp, { execute: "screendump", arguments: { filename: shot } }, z.object({})).then(
        async () => litFraction(await readFile(shot)) > 0.5,
        () => false,
      );
    for (let i = 0; i < 300; i++) {
      await sleep(2000);
      if (await lit()) break;
      await qmp(control.qmp, [
        { execute: "send-key", arguments: { keys: [{ type: "qcode", data: "ret" }] } },
      ]).catch(() => undefined);
    }
    const started = Date.now();
    let last: string | null = null;
    let lastAt = Date.now();
    let heard = 0;
    /** When it said it was done: it's flushed its disk by then, and only has to stop. */
    let doneAt: number | null = null;
    try {
      for (let tick = 0; pid && alive(pid); tick++) {
        await sleep(15_000);
        // All of it, not just the last: a step can come and go between looks.
        const sayings = installSayings(await readFile(said, "latin1").catch(() => ""));
        for (const saying of sayings.slice(heard)) ctx.log(`Windows' install: ${saying}`);
        if (sayings.length > heard) lastAt = Date.now();
        heard = sayings.length;
        last = sayings.at(-1) ?? null;
        if (doneAt === null && sayings.includes(INSTALL_DONE)) doneAt = Date.now();
        if (doneAt !== null) {
          // Windows has started again rather than shut down, as it has after
          // Visual C++'s runtime went in: asked to stop, then made to.
          const waited = Date.now() - doneAt;
          if (waited > DONE_GRACE_MS * 2) {
            ctx.log("Windows didn't stop after its install was done; turning it off");
            process.kill(pid, "SIGKILL");
          } else if (waited > DONE_GRACE_MS) {
            await qmp(control.qmp, [{ execute: "system_powerdown" }]).catch(() => undefined);
          }
          continue;
        }
        // Before it says anything, setup's own screen being up is all it says.
        if (last === null && (await lit())) lastAt = Date.now();
        const quiet =
          Date.now() - lastAt >
          (last === null ? INSTALL_FIRST_WORD_MINUTES : INSTALL_QUIET_MINUTES) * 60_000;
        const failed = last?.startsWith(INSTALL_FAILED) ?? false;
        // PNG needs QEMU 7.1; an older one just doesn't save it.
        if (tick % 4 === 0 || failed || quiet) {
          await qmp(control.qmp, [
            { execute: "screendump", arguments: { filename: screen, format: "png" } },
          ]).catch(() => undefined);
        }
        if (last && failed) {
          throw new Error(`Windows' install failed: ${last.slice(INSTALL_FAILED.length)}`);
        }
        if (quiet) {
          throw new Error(
            last === null
              ? `Windows' setup said nothing, and showed nothing, in ${INSTALL_FIRST_WORD_MINUTES} minutes: it may not have started from its installer. Its screen is in ${screen}`
              : `Windows' install went quiet for ${INSTALL_QUIET_MINUTES} minutes after it said "${last}". Its screen is in ${screen}`,
          );
        }
        const minutes = Math.round((Date.now() - started) / 60_000);
        if (minutes > INSTALL_HOURS * 60) {
          throw new Error(
            `Windows took too long to install: ${last ? `it last said "${last}"` : "its setup never got as far as Nibblets'"}. Its screen is in ${screen}`,
          );
        }
        job.progress(null, `${last ?? "Installing Windows"} (${minutes} minutes so far)`);
      }
      last = installSaid(await tailFile(said));
      if (doneAt === null && last !== INSTALL_DONE) {
        throw new Error(
          `Windows' installer stopped before it was done: ${last ? `it last said "${last}"` : "its setup never got as far as Nibblets'"}. Its screen is in ${screen}`,
        );
      }
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      for (const f of [setup, shot, control.qmp, control.pid]) await rm(f, { force: true });
    }
  }

  async start(_ctx: HostContext, vm: VmSpec): Promise<void> {
    const fw = firmware();
    if (!fw) throw new Error("There's no UEFI firmware for QEMU");
    const f = files(vm);
    await mkdir(vm.dir, { recursive: true });
    if (vm.fresh || !existsSync(f.system)) {
      // An overlay on the image: only what the guest changes is written here.
      // Windows' is the size it was installed on, partitions and all;
      // Linux's grows to SYSTEM_GB, which its root already is.
      const [base, format, size] =
        vm.guest === "windows"
          ? [join(vm.imageDir, "disk.qcow2"), "qcow2", []]
          : [join(vm.imageDir, linuxDiskFile("raw")), "raw", [`${SYSTEM_GB}G`]];
      await rm(f.system, { force: true });
      await run("qemu-img", [
        "create",
        "-q",
        "-f",
        "qcow2",
        "-F",
        format,
        "-b",
        base,
        f.system,
        ...size,
      ]);
      // A Windows image's boot entries are in the variables it was installed with.
      await copyFile(vm.guest === "windows" ? join(vm.imageDir, "efi-vars.fd") : fw.vars, f.vars);
    }
    if (!existsSync(f.home)) {
      await run("qemu-img", ["create", "-q", "-f", "qcow2", f.home, `${HOME_GB}G`]);
    }
    if (!existsSync(f.vars)) await copyFile(fw.vars, f.vars);
    if (!existsSync(f.mac)) await writeFile(f.mac, randomMac());
    await rename(f.console, `${f.console}.old`).catch(() => undefined);
    for (const socket of [f.agent, f.qmp]) await rm(socket, { force: true });
    const mac = (await readFile(f.mac, "utf8")).trim();
    await qemu(
      this.accel,
      [
        ...baseArgs(this.accel, `nibblet-${vm.id}`, vm, { ...fw, vars: f.vars }, f),
        ...deviceArgs(vm.guest, f, { agent: f.agent, console: f.console }, mac),
      ],
      { qmp: f.qmp, log: f.qemuLog },
    );
  }

  private pid(vm: VmRef): Promise<number | null> {
    return livePid(files(vm).pid);
  }

  async running(_ctx: HostContext, vm: VmRef): Promise<boolean> {
    const pid = await this.pid(vm);
    if (!pid) return false;
    // A pid the system's since given to something else isn't its QEMU.
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    return cmdline.includes(`nibblet-${vm.id}`);
  }

  async stop(ctx: HostContext, vm: VmRef, force: boolean): Promise<void> {
    if (!(await this.running(ctx, vm))) return;
    const pid = await this.pid(vm);
    if (!force) {
      // The ACPI power button: the guest shuts itself down.
      await qmp(files(vm).qmp, [{ execute: "system_powerdown" }]).catch(() => undefined);
      return;
    }
    await qmp(files(vm).qmp, [{ execute: "quit" }]).catch(() => undefined);
    for (let i = 0; i < 40 && pid && alive(pid); i++) await sleep(250);
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  }

  async remove(ctx: HostContext, vm: VmRef): Promise<void> {
    await this.stop(ctx, vm, true);
    const f = files(vm);
    for (const socket of [f.agent, f.qmp]) await rm(socket, { force: true });
  }

  connect(_ctx: HostContext, vm: VmRef): Promise<Duplex> {
    return connectTo(files(vm).agent);
  }

  /**
   * Its console. Windows says nothing there, so then it's what QEMU said,
   * and its screen, saved for looking at.
   */
  async console(ctx: HostContext, vm: VmRef): Promise<string> {
    const f = files(vm);
    const said = await tailFile(f.console);
    if (said.trim()) return said;
    if (await this.running(ctx, vm)) {
      await rm(f.screen, { force: true });
      await qmp(f.qmp, [
        { execute: "screendump", arguments: { filename: f.screen, format: "png" } },
      ]).catch(() => undefined);
    }
    const qemuSaid = (await tailFile(f.qemuLog, 4000)).trim();
    return [
      qemuSaid ? `QEMU said:\n${qemuSaid}` : "",
      existsSync(f.screen) ? `Its screen is in ${f.screen}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async capacity() {
    return { cpus: cpus().length, memoryMb: Math.floor(totalmem() / 1024 / 1024) };
  }
}
