import { execFile } from "node:child_process";
import {
  access,
  constants,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { GUEST_PORT_NAME, type GuestImage, type GuestOs } from "@nibblet/protocol";
import {
  alive,
  connectTo,
  linuxDiskFile,
  livePid,
  randomMac,
  sleep,
  socketPath,
  tailFile,
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

/** QEMU's name for this machine's architecture, and the machine type it boots with KVM. */
const ARCH =
  process.arch === "arm64"
    ? { qemu: "qemu-system-aarch64", machine: "virt,accel=kvm,gic-version=host" }
    : { qemu: "qemu-system-x86_64", machine: "q35,accel=kvm" };

/**
 * UEFI firmware, as distributions package it: the code, read-only, and a
 * template for each VM's own variables.
 */
const FIRMWARE =
  process.arch === "arm64"
    ? [
        ["/usr/share/AAVMF/AAVMF_CODE.fd", "/usr/share/AAVMF/AAVMF_VARS.fd"],
        [
          "/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw",
          "/usr/share/edk2/aarch64/vars-template-pflash.raw",
        ],
        ["/usr/share/qemu-efi-aarch64/QEMU_EFI.fd", "/usr/share/AAVMF/AAVMF_VARS.fd"],
      ]
    : [
        ["/usr/share/OVMF/OVMF_CODE_4M.fd", "/usr/share/OVMF/OVMF_VARS_4M.fd"],
        ["/usr/share/OVMF/OVMF_CODE.fd", "/usr/share/OVMF/OVMF_VARS.fd"],
        ["/usr/share/edk2/ovmf/OVMF_CODE.fd", "/usr/share/edk2/ovmf/OVMF_VARS.fd"],
        ["/usr/share/edk2/x64/OVMF_CODE.4m.fd", "/usr/share/edk2/x64/OVMF_VARS.4m.fd"],
      ];

function firmware(): { code: string; vars: string } | null {
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
  log: join(vm.dir, "qemu.log"),
  agent: socketPath("kvm", vm.id, "agent"),
  qmp: socketPath("kvm", vm.id, "qmp"),
});

/** Says one thing to a VM's QEMU over QMP, its control socket. */
async function qmp(vm: VmRef, command: string): Promise<void> {
  const socket = await connectTo(files(vm).qmp);
  await new Promise<void>((resolve, reject) => {
    let said = false;
    socket.on("data", (chunk: Buffer) => {
      // The greeting first, then capabilities' answer: then it listens.
      if (!said && chunk.toString().includes('"QMP"')) {
        socket.write(JSON.stringify({ execute: "qmp_capabilities" }));
      } else if (!said && chunk.toString().includes('"return"')) {
        said = true;
        socket.write(JSON.stringify({ execute: command }));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      }
    });
    socket.once("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("QEMU didn't answer"));
    }, 5000);
  });
}

/**
 * KVM, through QEMU, on Linux: Linux guests from the runner image (the
 * same disk as Apple's, under a qcow2 overlay for each VM). Each VM is a
 * daemonised QEMU, so it outlives the bridge, with its agent's port as a
 * virtio serial port on a unix socket, and user-mode networking, where the
 * host is 10.0.2.2 and nothing on the host's own networks is in the way.
 */
export class Kvm implements HypervisorPlugin {
  readonly id = meta.id;
  readonly name = meta.name;
  readonly diskFormat: "raw" = "raw";

  async detect(_ctx: HostContext) {
    if (process.platform !== "linux")
      return { available: false, detail: "Only on Linux", guests: [] };
    const kvm = await access("/dev/kvm", constants.R_OK | constants.W_OK).then(
      () => null,
      () =>
        existsSync("/dev/kvm")
          ? "You're not in the kvm group, so can't use /dev/kvm (add yourself and log in again)"
          : "There's no /dev/kvm: this machine's CPU or its VM doesn't offer KVM",
    );
    if (kvm) return { available: false, detail: kvm, guests: [] };
    const qemu = await run(ARCH.qemu, ["--version"]).then(
      () => null,
      () => `${ARCH.qemu} isn't installed`,
    );
    if (qemu) return { available: false, detail: qemu, guests: [] };
    const img = await run("qemu-img", ["--version"]).then(
      () => null,
      () => "qemu-img isn't installed",
    );
    if (img) return { available: false, detail: img, guests: [] };
    if (!firmware()) {
      return {
        available: false,
        detail: "There's no UEFI firmware for QEMU (OVMF or AAVMF)",
        guests: [],
      };
    }
    const guests: GuestOs[] = ["linux"];
    return { available: true, detail: null, guests };
  }

  imageSource(): GuestImage["source"] {
    return "none";
  }

  async prepareImage(_ctx: HostContext, guest: GuestOs, _job: ImageJob): Promise<void> {
    throw new Error(`KVM doesn't make ${guest} images yet`);
  }

  async start(_ctx: HostContext, vm: VmSpec): Promise<void> {
    if (vm.guest !== "linux") throw new Error("KVM runs Linux guests");
    const fw = firmware();
    if (!fw) throw new Error("There's no UEFI firmware for QEMU");
    const f = files(vm);
    await mkdir(vm.dir, { recursive: true });
    if (vm.fresh || !existsSync(f.system)) {
      // An overlay on the image: only what the guest changes is written here.
      await rm(f.system, { force: true });
      await run("qemu-img", [
        "create",
        "-q",
        "-f",
        "qcow2",
        "-F",
        "raw",
        "-b",
        join(vm.imageDir, linuxDiskFile("raw")),
        f.system,
        `${SYSTEM_GB}G`,
      ]);
      await copyFile(fw.vars, f.vars);
    }
    if (!existsSync(f.home))
      await run("qemu-img", ["create", "-q", "-f", "qcow2", f.home, `${HOME_GB}G`]);
    if (!existsSync(f.vars)) await copyFile(fw.vars, f.vars);
    if (!existsSync(f.mac)) await writeFile(f.mac, randomMac());
    await rename(f.console, `${f.console}.old`).catch(() => undefined);
    for (const socket of [f.agent, f.qmp]) await rm(socket, { force: true });
    const mac = (await readFile(f.mac, "utf8")).trim();
    const args = [
      "-name",
      `nibblet-${vm.id}`,
      "-machine",
      ARCH.machine,
      "-cpu",
      "host",
      "-smp",
      String(vm.cpus),
      "-m",
      String(vm.memoryMb),
      "-drive",
      `if=pflash,format=raw,readonly=on,file=${fw.code}`,
      "-drive",
      `if=pflash,format=raw,file=${f.vars}`,
      "-drive",
      `file=${f.system},if=virtio,format=qcow2,discard=unmap`,
      "-drive",
      `file=${f.home},if=virtio,format=qcow2,discard=unmap`,
      "-netdev",
      "user,id=net0",
      "-device",
      `virtio-net-pci,netdev=net0,mac=${mac}`,
      "-device",
      "virtio-rng-pci",
      // One virtio serial bus: the console (hvc0) to a file, and the agent's port.
      "-device",
      "virtio-serial-pci",
      "-chardev",
      `file,id=console,path=${f.console}`,
      "-device",
      "virtconsole,chardev=console",
      "-chardev",
      `socket,id=agent,path=${f.agent},server=on,wait=off`,
      "-device",
      `virtserialport,chardev=agent,name=${GUEST_PORT_NAME}`,
      "-qmp",
      `unix:${f.qmp},server=on,wait=off`,
      "-display",
      "none",
      "-monitor",
      "none",
      "-serial",
      "none",
      "-daemonize",
      "-pidfile",
      f.pid,
    ];
    await run(ARCH.qemu, args, { timeout: 60_000 }).catch((err: unknown) => {
      throw new Error(`QEMU didn't start: ${err instanceof Error ? err.message : String(err)}`);
    });
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
      await qmp(vm, "system_powerdown").catch(() => undefined);
      return;
    }
    await qmp(vm, "quit").catch(() => undefined);
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

  console(_ctx: HostContext, vm: VmRef): Promise<string> {
    return tailFile(files(vm).console);
  }

  async capacity() {
    return { cpus: cpus().length, memoryMb: Math.floor(totalmem() / 1024 / 1024) };
  }
}
