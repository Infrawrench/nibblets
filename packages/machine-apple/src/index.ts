import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { GuestImage, GuestOs } from "@nibblet/protocol";
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
import { z } from "zod";
import { prepareMacos } from "./macos.ts";
import { meta } from "./meta.ts";

const run = promisify(execFile);

/** What the helper's own source and entitlements are, for building it where there's no prebuilt one. */
const SOURCE = fileURLToPath(new URL("../helper/main.swift", import.meta.url));
const ENTITLEMENTS = fileURLToPath(new URL("../helper/vm.entitlements", import.meta.url));

/** How big a VM's disks grow to: the system disk (from a much smaller image), and its home. */
const SYSTEM_GB = 32;
const HOME_GB = 64;

const State = z.object({
  state: z.enum(["starting", "running", "stopped"]),
  pid: z.int(),
  error: z.string().optional(),
});

const Check = z.object({ supported: z.boolean(), macos: z.boolean() });

export interface AppleOptions {
  /**
   * The helper, built and signed with the virtualization entitlement (the
   * desktop app ships one). Without it, it's built from source with the
   * Swift compiler the first time, and signed for this Mac alone.
   */
  helper?: string;
}

const files = (vm: VmRef) => ({
  spec: join(vm.dir, "helper.json"),
  state: join(vm.dir, "state.json"),
  pid: join(vm.dir, "helper.pid"),
  console: join(vm.dir, "console.log"),
  helperLog: join(vm.dir, "helper.log"),
  mac: join(vm.dir, "mac"),
  system: join(vm.dir, "system.img"),
  home: join(vm.dir, "home.img"),
  efi: join(vm.dir, "efi-vars"),
  aux: join(vm.dir, "aux.img"),
  socket: socketPath("apple", vm.id, "agent"),
});

/** Copies a file with APFS's clonefile where it can (instant, and sharing blocks), or byte for byte. */
async function clone(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  await run("cp", ["-c", from, to]).catch(() => copyFile(from, to));
}

/**
 * Apple's Virtualization framework, on a Mac: Linux guests (from the runner
 * image) on any Mac it runs on, and macOS guests on Apple silicon. Each VM
 * is a `nibblet-vm run` of its own (see helper/main.swift), started
 * detached so it outlives the bridge as a container outlives the app,
 * with its agent's port on a unix socket.
 */
export class AppleVirtualization implements HypervisorPlugin {
  readonly id = meta.id;
  readonly name = meta.name;
  readonly diskFormat: "raw" = "raw";
  private readonly given: string | undefined;
  private built: Promise<string> | null = null;

  constructor(opts: AppleOptions = {}) {
    this.given = opts.helper;
  }

  /** The helper, built (once) if there's no prebuilt one. */
  helper(ctx: HostContext): Promise<string> {
    if (this.given) return Promise.resolve(this.given);
    if (!this.built) {
      this.built = (async () => {
        const bin = join(ctx.dir, "bin", "nibblet-vm");
        const fresh = await Promise.all([stat(bin), stat(SOURCE)]).then(
          ([b, s]) => b.mtimeMs >= s.mtimeMs,
          () => false,
        );
        if (fresh) return bin;
        await mkdir(join(ctx.dir, "bin"), { recursive: true });
        ctx.log("building nibblet-vm");
        await run(
          "swiftc",
          [
            "-O",
            "-swift-version",
            "5",
            "-o",
            `${bin}.new`,
            SOURCE,
            "-framework",
            "Virtualization",
            "-framework",
            "AppKit",
          ],
          { timeout: 10 * 60_000 },
        ).catch((err: unknown) => {
          throw new Error(
            `Couldn't build the VM helper (it needs Xcode's command line tools): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        await run("codesign", ["-s", "-", "-f", "--entitlements", ENTITLEMENTS, `${bin}.new`]);
        await rename(`${bin}.new`, bin);
        return bin;
      })().catch((err: unknown) => {
        this.built = null;
        throw err;
      });
    }
    return this.built;
  }

  async detect(ctx: HostContext) {
    if (process.platform !== "darwin") {
      return { available: false, detail: "Only on a Mac", guests: [] };
    }
    const helper = await this.helper(ctx);
    const check = Check.parse(JSON.parse((await run(helper, ["check"])).stdout));
    if (!check.supported) {
      return { available: false, detail: "This Mac can't run virtual machines", guests: [] };
    }
    const guests: GuestOs[] = ["linux"];
    // macOS guests come once their image can be given the guest agent.
    if (check.macos && arch() === "arm64" && process.env.NIBBLET_MACOS_GUESTS) guests.push("macos");
    return { available: true, detail: null, guests };
  }

  imageSource(): GuestImage["source"] {
    return "none";
  }

  async prepareImage(ctx: HostContext, guest: GuestOs, job: ImageJob): Promise<void> {
    if (guest !== "macos")
      throw new Error(`Apple Virtualization doesn't make ${guest} images itself`);
    await prepareMacos(ctx, await this.helper(ctx), job);
  }

  async start(ctx: HostContext, vm: VmSpec): Promise<void> {
    const f = files(vm);
    await mkdir(vm.dir, { recursive: true });
    const helper = await this.helper(ctx);
    if (vm.fresh || !existsSync(f.system)) {
      if (vm.guest === "linux") {
        await clone(join(vm.imageDir, linuxDiskFile("raw")), f.system);
        // The image is only as big as what's on it; the guest grows its root to fill this.
        await truncate(f.system, SYSTEM_GB * 1024 ** 3);
        // A new disk's boot entries are its own.
        await rm(f.efi, { force: true });
      } else {
        await clone(join(vm.imageDir, "disk.img"), f.system);
        await clone(join(vm.imageDir, "aux.img"), f.aux);
      }
    }
    if (!existsSync(f.home)) {
      await writeFile(f.home, "");
      await truncate(f.home, HOME_GB * 1024 ** 3);
    }
    if (!existsSync(f.mac)) await writeFile(f.mac, randomMac());
    // Last boot's console, for one more look; this boot's starts afresh.
    await rename(f.console, `${f.console}.old`).catch(() => undefined);
    await rm(f.state, { force: true });
    const spec = {
      guest: vm.guest,
      cpus: vm.cpus,
      memoryMb: vm.memoryMb,
      disks: [
        { path: f.system, readOnly: false },
        { path: f.home, readOnly: false },
      ],
      efiVariables: vm.guest === "linux" ? f.efi : null,
      macos:
        vm.guest === "macos"
          ? {
              hardwareModel: join(vm.imageDir, "hardware-model"),
              machineIdentifier: join(vm.imageDir, "machine-identifier"),
              auxiliaryStorage: f.aux,
            }
          : null,
      macAddress: (await readFile(f.mac, "utf8")).trim(),
      console: f.console,
      agentSocket: f.socket,
      state: f.state,
    };
    await writeFile(f.spec, JSON.stringify(spec, null, 2));
    const log = await open(f.helperLog, "a");
    const child = spawn(helper, ["run", f.spec, ...(process.env.NIBBLET_VM_GUI ? ["--gui"] : [])], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
    if (!child.pid) throw new Error("The VM helper didn't start");
    await writeFile(f.pid, String(child.pid));
    // Running, or why not.
    for (let i = 0; i < 120; i++) {
      const state = await this.state(vm);
      if (state?.state === "running") return;
      if (state?.state === "stopped" || !alive(child.pid)) {
        const said = (await readFile(f.helperLog, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ");
        throw new Error(state?.error ?? (said || "The VM stopped as it started"));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("The VM took too long to start");
  }

  private async state(vm: VmRef): Promise<z.infer<typeof State> | null> {
    const text = await readFile(files(vm).state, "utf8").catch(() => null);
    if (!text) return null;
    const parsed = State.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  }

  private pid(vm: VmRef): Promise<number | null> {
    return livePid(files(vm).pid);
  }

  async running(_ctx: HostContext, vm: VmRef): Promise<boolean> {
    const [pid, state] = await Promise.all([this.pid(vm), this.state(vm)]);
    // The pid's its helper's, not one the system's since given to something else.
    return pid !== null && state !== null && state.pid === pid && state.state !== "stopped";
  }

  async stop(_ctx: HostContext, vm: VmRef, force: boolean): Promise<void> {
    const pid = await this.pid(vm);
    if (!pid) return;
    // The helper asks the guest to shut down on SIGTERM, and pulls the plug on SIGINT.
    process.kill(pid, force ? "SIGINT" : "SIGTERM");
    if (!force) return;
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }

  async remove(ctx: HostContext, vm: VmRef): Promise<void> {
    await this.stop(ctx, vm, true);
    await rm(files(vm).socket, { force: true });
  }

  connect(_ctx: HostContext, vm: VmRef): Promise<Duplex> {
    return connectTo(files(vm).socket);
  }

  console(_ctx: HostContext, vm: VmRef): Promise<string> {
    return tailFile(files(vm).console);
  }

  async capacity() {
    return { cpus: cpus().length, memoryMb: Math.floor(totalmem() / 1024 / 1024) };
  }
}
