import { createServer, type Server } from "node:net";
import { pipeline, Readable, Transform, Writable } from "node:stream";
import {
  DEFAULT_MEMORY_MB,
  GUEST_NAMES,
  MAIN_RUN,
  subagentRun,
  type GuestOs,
  type MachineBackend,
  type MachineCapabilities,
  type Resources,
} from "@nibblet/protocol";
import type { HostImage, VmInfo } from "./bridge-api.ts";
import { BridgeError, type HypervisorClient } from "./bridge-client.ts";
import { GuestLink, type RunExit } from "./guest-link.ts";
import type {
  ExitListener,
  MachineEnv,
  MachinePlugin,
  MachineSpec,
  MachineState,
  SubagentExit,
} from "./plugin.ts";

/** What the server knows of a hypervisor plugin without loading it (it runs on the host). */
export interface HypervisorMeta {
  /** Its machine plugin's id, as stored with each nibblet. */
  id: string;
  name: string;
}

/**
 * What a virtual machine can do, by guest. Linux guests run the runner
 * image itself, so they have its browser and Tailscale. Windows guests
 * have a browser (Edge) and a desktop, on the session they sign in to at
 * boot; macOS guests have neither yet, and neither has Tailscale yet. None
 * share the host's SSH agent, and a VM's size is fixed while it runs.
 */
export function vmCapabilities(guest: GuestOs): MachineCapabilities {
  const linux = guest === "linux";
  return {
    browser: linux || guest === "windows",
    tailscale: linux,
    sshAgent: false,
    liveResources: false,
  };
}

/** How big a VM is: whole CPUs, and the memory limit a container would have had. */
export function vmSize(r: Resources, hostCpus: number | null): { cpus: number; memoryMb: number } {
  const cpus = r.cpus === null ? Math.min(4, hostCpus ?? 4) : Math.ceil(r.cpus);
  return { cpus: Math.max(1, cpus), memoryMb: r.memoryMb ?? DEFAULT_MEMORY_MB };
}

export interface VmPluginOptions {
  meta: HypervisorMeta;
  client: HypervisorClient;
  /** The runner image Linux guests are made from, on the stack's engine: its name and current id. */
  runnerImage: () => Promise<{ name: string; id: string } | null>;
  /** The Nibblets release this server runs: what Windows and macOS guests install. */
  version: string;
  /** Where its releases come from, as `owner/repo` on GitHub. */
  repo?: string;
  /** The git ref guests that install the runner themselves install, if not the release's tag. */
  ref?: string;
  log?: (message: string) => void;
}

/** How long a VM gets to come up and say hello. */
const BOOT_TIMEOUT_MS = 5 * 60_000;
/** What its entry gets to stop, as a container's does: past the entry's own 10 seconds. */
const STOP_SECONDS = 12;
/** And then the guest, to shut itself down. */
const SHUTDOWN_SECONDS = 45;

/** Booted for a job alone (a snapshot, tidying up): as small as will do. */
const JOB_SIZE = { cpus: 2, memoryMb: 2048 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Virtual machines on the host, made by one of its hypervisors (Apple
 * Virtualization, Hyper-V) through the host bridge: the same contract as a
 * container, so the conductor treats them alike. Inside each VM, the guest
 * agent does what `docker exec` would, over its serial port (see
 * protocol's guest.ts); this keeps one link to each.
 *
 * Starting one makes sure its image is ready and current first (Linux's
 * is made from the runner image, which takes a few minutes the first time
 * and after each update), then boots it and runs the nibblet's entry.
 * Snapshotting or tidying up one that's off boots it for the job without
 * starting the nibblet, and shuts it down again.
 */
export class VirtualMachines implements MachinePlugin {
  readonly id: string;
  readonly name: string;
  readonly kind: "vm" = "vm";
  private readonly client: HypervisorClient;
  private readonly runnerImage: VmPluginOptions["runnerImage"];
  private readonly version: string;
  private readonly repo: string | undefined;
  private readonly ref: string | undefined;
  private readonly log: (message: string) => void;
  private readonly links = new Map<string, GuestLink>();
  private readonly linking = new Map<string, Promise<GuestLink>>();
  /** One thing at a time to each VM: starting, stopping, a job on one that's off. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The boot each running nibblet is on, as this server knows it. */
  private readonly boots = new Map<string, string>();
  /** Boots whose end is expected (stopping, a job), or already reported. */
  private readonly settled = new Set<string>();
  /** Sub-agents running in each VM, to hear of their end on whichever link. */
  private readonly subagents = new Map<string, { host: string; onExit: SubagentExit }>();
  /** Listeners for ports inside VMs, by `id:port`; a promise, so two asking at once share one. */
  private readonly tunnels = new Map<string, Promise<{ server: Server; port: number }>>();
  private listener: ExitListener | null = null;

  constructor(opts: VmPluginOptions) {
    this.id = opts.meta.id;
    this.name = opts.meta.name;
    this.client = opts.client;
    this.runnerImage = opts.runnerImage;
    this.version = opts.version;
    this.repo = opts.repo;
    this.ref = opts.ref;
    this.log = opts.log ?? ((m) => console.log(`${this.id}: ${m}`));
  }

  private exclusive<T>(id: string, job: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(job);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  async describe(): Promise<MachineBackend | null> {
    const base: Pick<MachineBackend, "id" | "name" | "kind" | "recommended"> = {
      id: this.id,
      name: this.name,
      kind: this.kind,
      recommended: false,
    };
    // No bridge, or one on a host without this hypervisor: not here at all.
    if (!this.client.configured) return null;
    const hv = (await this.client.host()).hypervisors.find((h) => h.id === this.id);
    if (!hv) return null;
    return {
      ...base,
      available: hv.available,
      detail: hv.detail,
      guests: hv.guests.map((g) => ({
        os: g.os,
        image: {
          state: g.image.state,
          detail: g.image.detail,
          progress: g.image.progress,
          source: g.image.source,
        },
        capabilities: vmCapabilities(g.os),
      })),
    };
  }

  capabilities(guest: GuestOs): MachineCapabilities {
    return vmCapabilities(guest);
  }

  async prepare(guest: GuestOs, source: string | undefined): Promise<void> {
    const runner = guest === "linux" ? await this.runnerImage() : null;
    await this.client.prepare(guest, {
      ...(source ? { source } : {}),
      ...(runner ? { runnerImage: runner.name } : this.release()),
    });
  }

  /** What a guest that installs the runner itself is to install. */
  private release(): { version: string; repo?: string; ref?: string } {
    return {
      version: this.version,
      ...(this.repo ? { repo: this.repo } : {}),
      ...(this.ref ? { ref: this.ref } : {}),
    };
  }

  private async image(guest: GuestOs): Promise<HostImage | null> {
    const hv = (await this.client.host()).hypervisors.find((h) => h.id === this.id);
    return hv?.guests.find((g) => g.os === guest)?.image ?? null;
  }

  /**
   * Waits for a guest's image to be ready, and for Linux made from the
   * current runner image, making it when it can (one that needs a source
   * from the user can't be). Returns what it was made from.
   */
  private async readyImage(guest: GuestOs, progress: (detail: string) => void): Promise<string> {
    const runner = guest === "linux" ? await this.runnerImage() : null;
    if (guest === "linux" && !runner)
      throw new Error("The runner image isn't here to make it from");
    let asked = false;
    for (;;) {
      const image = await this.image(guest);
      if (!image) throw new Error(`${this.name} can't run ${GUEST_NAMES[guest]} here`);
      const current = !runner || image.builtFrom === runner.id;
      if (image.state === "ready" && current) return image.builtFrom ?? "";
      if (image.state === "preparing") {
        const pct = image.progress === null ? "" : ` (${Math.round(image.progress * 100)}%)`;
        progress(
          `Making its ${GUEST_NAMES[guest]} image${pct}${image.detail ? `: ${image.detail}` : ""}`,
        );
        await sleep(3000);
        continue;
      }
      if (image.state === "error" && asked) {
        throw new Error(image.detail ?? `Couldn't make its ${GUEST_NAMES[guest]} image`);
      }
      if (image.source !== "none" && image.state !== "ready") {
        throw new Error(
          `Its ${GUEST_NAMES[guest]} image isn't made yet: make it in Settings, with an installer`,
        );
      }
      // Missing, failed before, or made from an older runner image.
      if (!asked) {
        progress(`Making its ${GUEST_NAMES[guest]} image`);
        await this.client.prepare(guest, runner ? { runnerImage: runner.name } : this.release());
        asked = true;
      }
      await sleep(2000);
    }
  }

  private async vm(id: string): Promise<VmInfo | null> {
    return (await this.client.vms()).find((v) => v.id === id) ?? null;
  }

  async machines(): Promise<Map<string, MachineState>> {
    const out = new Map<string, MachineState>();
    // No bridge, or none of this hypervisor on the host: there are none. A bridge that's down is an error.
    if (!this.client.configured) return out;
    const vms = await this.client.vms().catch((err: unknown) => {
      if (err instanceof BridgeError && err.status === 404) return [];
      throw err;
    });
    for (const vm of vms) {
      out.set(vm.id, { id: `vm:${vm.boot ?? ""}`, running: vm.running });
      // From before this server: what it's on, to hear of its end.
      if (vm.running && vm.boot && !this.boots.has(vm.id)) this.boots.set(vm.id, vm.boot);
    }
    return out;
  }

  async watchExits(listener: ExitListener): Promise<void> {
    this.listener = listener;
    // Those left running by the last server: links to them again, to hear when they stop.
    for (const [id, boot] of this.boots) {
      void this.link(id)
        .then((link) => this.watch(id, link, boot))
        .catch((err: unknown) => this.log(`couldn't reach ${id}'s agent: ${String(err)}`));
    }
    // Belt and braces: a VM that went without its link saying so.
    setInterval(() => void this.sweep(), 15_000).unref();
  }

  private async sweep(): Promise<void> {
    if (this.boots.size === 0) return;
    const vms = await this.client.vms().catch(() => null);
    if (!vms) return;
    for (const [id, boot] of this.boots) {
      const vm = vms.find((v) => v.id === id);
      if (!vm?.running || vm.boot !== boot) this.ended(id, boot, null);
    }
  }

  /** A boot is over: said once, unless it was meant to be. */
  private ended(id: string, boot: string, code: number | null): void {
    if (this.boots.get(id) === boot) this.boots.delete(id);
    this.closeTunnels(id);
    if (this.settled.has(boot)) return;
    this.settled.add(boot);
    this.listener?.(id, code);
    // Its entry's gone, as a container's would be with it: so is the guest,
    // and whatever else it had running (sub-agents), rather than idling on.
    void this.exclusive(id, async () => {
      const vm = await this.vm(id);
      if (vm?.running && vm.boot === boot) await this.shutdown(id, vm);
    }).catch((err: unknown) =>
      this.log(`couldn't stop ${id} after its entry ended: ${String(err)}`),
    );
  }

  /** Hears the nibblet's entry end, on this link or, if it drops, the next. */
  private watch(id: string, link: GuestLink, boot: string): void {
    // A link that's new to this boot may come after the entry's gone with
    // nobody to say how (its agent restarted, and its processes with it).
    if (!link.isRunning(MAIN_RUN) && !link.hasExit(MAIN_RUN)) {
      this.ended(id, boot, null);
      return;
    }
    void Promise.race([link.exited(MAIN_RUN), link.gone.then(() => null)]).then(
      (exit: RunExit | null) => {
        if (exit) return this.ended(id, boot, exit.code);
        if (this.boots.get(id) !== boot || this.settled.has(boot)) return;
        // The link went, not (as far as we know) the guest: link again.
        void this.relink(id, boot);
      },
    );
  }

  private async relink(id: string, boot: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      if (this.boots.get(id) !== boot || this.settled.has(boot)) return;
      const vm = await this.vm(id).catch(() => undefined);
      if (vm === undefined) continue;
      if (!vm?.running || vm.boot !== boot) return this.ended(id, boot, null);
      try {
        const link = await this.link(id);
        this.watch(id, link, boot);
        this.rewatchSubagents(id, link);
        return;
      } catch (err) {
        this.log(`couldn't reach ${id}'s agent again: ${String(err)}`);
      }
    }
    this.ended(id, boot, null);
  }

  /** A link to a running VM's agent: the one there is, or a new one. */
  private link(id: string): Promise<GuestLink> {
    const now = this.links.get(id);
    if (now && !now.closed) return Promise.resolve(now);
    let linking = this.linking.get(id);
    if (!linking) {
      linking = (async () => {
        const vm = await this.vm(id);
        if (!vm?.running || !vm.boot) throw new Error("Its virtual machine isn't running");
        const link = await GuestLink.open(await this.client.link(id), {
          nibbletId: id,
          boot: vm.boot,
        });
        link.log = (level, message) => this.log(`[${id}] agent ${level}: ${message}`);
        this.links.set(id, link);
        void link.gone.then(() => {
          if (this.links.get(id) === link) this.links.delete(id);
        });
        return link;
      })().finally(() => this.linking.delete(id));
      this.linking.set(id, linking);
    }
    return linking;
  }

  /** The first link to a boot: its agent takes a moment to start, so this keeps trying. */
  private async firstLink(id: string, boot: string): Promise<GuestLink> {
    const until = Date.now() + BOOT_TIMEOUT_MS;
    let last: unknown = null;
    while (Date.now() < until) {
      try {
        const link = await this.link(id);
        if (link.boot === boot) return link;
        link.close();
      } catch (err) {
        last = err;
      }
      await sleep(1500);
    }
    // Its console says why, if anything does: its boot, or for Windows what QEMU said and its screen.
    const said = (await this.client.console(id).catch(() => ""))
      .trim()
      .split("\n")
      .slice(-20)
      .join("\n");
    throw new Error(
      `Its virtual machine started, but its agent never answered${last instanceof Error ? `: ${last.message}` : ""}${said ? `\n${said}` : ""}`,
    );
  }

  private dropLink(id: string): void {
    this.links.get(id)?.close();
    this.links.delete(id);
  }

  async start(id: string, spec: MachineSpec): Promise<string> {
    return this.exclusive(id, async () => {
      const guest = spec.machine.guest;
      const builtFrom = await this.readyImage(guest, spec.progress);
      const before = await this.vm(id);
      if (before?.running) await this.shutdown(id, before);
      const size = vmSize(spec.resources, (await this.capacity().catch(() => null))?.cpus ?? null);
      spec.progress(`Starting its ${GUEST_NAMES[guest]} virtual machine`);
      const vm = await this.client.start(id, {
        guest,
        ...size,
        // A new runner image means a new system disk; the home disk stays.
        fresh: before !== null && before.image !== builtFrom,
        tailscale: spec.tailscale,
      });
      if (!vm.boot) throw new Error("It started without a boot id");
      this.boots.set(id, vm.boot);
      try {
        const link = await this.firstLink(id, vm.boot);
        await link.run({ run: MAIN_RUN, command: "main", env: spec.env });
        this.watch(id, link, vm.boot);
      } catch (err) {
        this.settled.add(vm.boot);
        this.boots.delete(id);
        await this.client.stop(id, true).catch(() => undefined);
        throw err;
      }
      return `vm:${vm.boot}`;
    });
  }

  /** Up for the nibblet: a VM booted for a job alone (a snapshot) doesn't count. */
  async running(id: string): Promise<boolean> {
    if (!this.boots.has(id)) return false;
    return (await this.vm(id))?.running ?? false;
  }

  async outdated(id: string): Promise<boolean> {
    const vm = await this.vm(id).catch(() => null);
    if (!vm || vm.guest !== "linux") return false;
    const runner = await this.runnerImage().catch(() => null);
    return runner !== null && vm.image !== null && vm.image !== runner.id;
  }

  /**
   * Stops its entry (SIGTERM, then the time a container gets), then has the
   * guest shut down, and pulls the plug if it won't.
   */
  private async shutdown(id: string, vm: VmInfo): Promise<void> {
    if (vm.boot) this.settled.add(vm.boot);
    this.boots.delete(id);
    const link = await this.link(id).catch(() => null);
    if (link) {
      try {
        if (link.isRunning(MAIN_RUN)) {
          link.signal(MAIN_RUN, "SIGTERM");
          await Promise.race([link.exited(MAIN_RUN), link.gone, sleep(STOP_SECONDS * 1000)]);
        }
        link.poweroff();
      } catch {
        // Gone already.
      }
    } else {
      await this.client.stop(id, false).catch(() => undefined);
    }
    const down = async (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        if (!(await this.vm(id).catch(() => null))?.running) return true;
        await sleep(1000);
      }
      return false;
    };
    // Its agent's asked; then the power button; then the plug.
    if (!(await down(SHUTDOWN_SECONDS / 3))) {
      await this.client.stop(id, false).catch(() => undefined);
      if (!(await down(SHUTDOWN_SECONDS))) await this.client.stop(id, true);
    }
    this.dropLink(id);
    this.closeTunnels(id);
  }

  async stop(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      const vm = await this.vm(id);
      if (vm?.running) await this.shutdown(id, vm);
    });
  }

  async discard(id: string): Promise<void> {
    const boot = this.boots.get(id);
    if (boot) this.settled.add(boot);
    this.boots.delete(id);
    this.dropLink(id);
    await this.client.stop(id, true).catch((err: unknown) => {
      if (!(err instanceof BridgeError && err.status === 404)) throw err;
    });
  }

  /** Its VM and its disks: everything, since a VM's home is one of them. */
  async removeHome(id: string): Promise<void> {
    await this.discard(id);
    await this.client.remove(id).catch((err: unknown) => {
      if (!(err instanceof BridgeError && err.status === 404)) throw err;
    });
  }

  async logs(id: string, tail: number): Promise<string> {
    // A sub-agent's are its run's, in its host's VM.
    const sub = this.subagents.get(id);
    const hostLink = sub ? this.links.get(sub.host) : undefined;
    const link = this.links.get(id);
    const text = hostLink
      ? await hostLink.tail(subagentRun(id)).catch(() => "")
      : link
        ? await link.tail(MAIN_RUN).catch(() => "")
        : await this.client.console(id).catch(() => "");
    return text.split("\n").slice(-tail).join("\n");
  }

  /**
   * A port inside it, as `127.0.0.1:<port>` in this server: a listener of
   * its own whose connections go through the guest's link.
   */
  async address(id: string, port: number): Promise<string | null> {
    if (!this.boots.has(id)) return null;
    const key = `${id}:${port}`;
    let tunnel = this.tunnels.get(key);
    if (!tunnel) {
      tunnel = this.listen(id, port);
      this.tunnels.set(key, tunnel);
      tunnel.catch(() => {
        if (this.tunnels.get(key) === tunnel) this.tunnels.delete(key);
      });
    }
    return `127.0.0.1:${(await tunnel).port}`;
  }

  private async listen(id: string, port: number): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => {
      socket.pause();
      this.link(id)
        .then((link) => link.open(port))
        .then((stream) => {
          socket.pipe(stream).pipe(socket);
          socket.resume();
          const done = () => {
            socket.destroy();
            stream.destroy();
          };
          socket.once("close", done);
          stream.once("close", done);
          socket.once("error", done);
          stream.once("error", done);
        })
        .catch(() => socket.destroy());
    });
    const local = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });
    return { server, port: local };
  }

  private closeTunnels(id: string): void {
    for (const [key, tunnel] of this.tunnels) {
      if (!key.startsWith(`${id}:`)) continue;
      this.tunnels.delete(key);
      void tunnel.then(
        ({ server }) => server.close(),
        () => undefined,
      );
    }
  }

  async startSubagent(
    hostId: string,
    nibbletId: string,
    env: MachineEnv,
    onExit: SubagentExit,
  ): Promise<void> {
    const link = await this.link(hostId);
    this.subagents.set(nibbletId, { host: hostId, onExit });
    await link.run({ run: subagentRun(nibbletId), command: "subagent", env });
    this.watchSubagent(nibbletId, link);
  }

  private watchSubagent(nibbletId: string, link: GuestLink): void {
    const run = subagentRun(nibbletId);
    void Promise.race([link.exited(run), link.gone.then(() => null)]).then(async (exit) => {
      // The link went: the next one picks it up (rewatchSubagents).
      if (!exit) return;
      const sub = this.subagents.get(nibbletId);
      if (!sub) return;
      this.subagents.delete(nibbletId);
      const tail = await link.tail(run).catch(() => "");
      // Said here too: a sub-agent's output is only in its host's VM.
      this.log(
        `[${nibbletId}] sub-agent stopped (${exit.code ?? exit.signal ?? exit.error ?? "?"}): ${tail.trim().split("\n").slice(-15).join("\n")}`,
      );
      sub.onExit(exit.code, exit.error ? `${tail}\n${exit.error}` : tail);
    });
  }

  private rewatchSubagents(hostId: string, link: GuestLink): void {
    for (const [nibbletId, sub] of this.subagents) {
      if (sub.host === hostId) this.watchSubagent(nibbletId, link);
    }
  }

  async stopSubagent(hostId: string, nibbletId: string): Promise<void> {
    this.subagents.delete(nibbletId);
    if (!(await this.running(hostId))) return;
    const link = await this.link(hostId);
    await link.runToEnd({ command: "stop-subagent", args: [nibbletId] }, 60_000);
    const tail = await link.tail(subagentRun(nibbletId)).catch(() => "");
    this.log(`[${nibbletId}] sub-agent stopped: ${tail.trim().split("\n").slice(-15).join("\n")}`);
  }

  async removeSubagentState(hostId: string, nibbletId: string): Promise<void> {
    await this.withGuest(hostId, (link) =>
      link.runToEnd({ command: "remove-subagent", args: [nibbletId] }, 60_000),
    );
  }

  /**
   * A job inside it: on its running VM, or, when it's off, booted for the
   * job alone (the nibblet isn't started) and shut down again.
   */
  private async withGuest(id: string, job: (link: GuestLink) => Promise<void>): Promise<void> {
    if (this.boots.has(id)) return job(await this.link(id));
    await this.exclusive(id, async () => {
      const vm = await this.vm(id);
      if (!vm) throw new Error("It hasn't had a virtual machine yet");
      if (vm.running) return job(await this.link(id));
      const booted = await this.client.start(id, {
        guest: vm.guest,
        ...JOB_SIZE,
        fresh: false,
        tailscale: vm.tailscale,
      });
      if (booted.boot) this.settled.add(booted.boot);
      try {
        await job(await this.firstLink(id, booted.boot ?? ""));
      } finally {
        await this.shutdown(id, booted);
      }
    });
  }

  async archiveHome(id: string, out: Writable): Promise<void> {
    // The caller ends `out`; the link ends what it's given.
    const stalled = new AbortController();
    const pass = metered(
      (m) => this.log(`[${id}] archiving its home: ${m}`),
      () => stalled.abort(new Error(STALLED)),
    );
    pass.pipe(out, { end: false });
    // Cut off, its channel's destroyed with an error: that's a failed snapshot, not a short one.
    const drained = new Promise<void>((resolve, reject) => {
      pass.once("end", resolve);
      pass.once("error", reject);
    });
    drained.catch(() => undefined);
    await this.withGuest(id, (link) =>
      link.runToEnd({ command: "archive-home", stdout: pass }, 60 * 60_000, stalled.signal),
    );
    await drained;
  }

  async restoreHome(id: string, archive: Readable): Promise<void> {
    const stalled = new AbortController();
    const sent = metered(
      (m) => this.log(`[${id}] restoring its home: ${m}`),
      () => stalled.abort(new Error(STALLED)),
    );
    // Its archive failing fails what the guest is sent, so the job ends.
    pipeline(archive, sent, () => {});
    await this.withGuest(id, (link) =>
      link.runToEnd({ command: "restore-home", stdin: sent }, 60 * 60_000, stalled.signal),
    );
  }

  async applyResources(id: string, resources: Resources): Promise<void> {
    const host = await this.capacity().catch(() => null);
    await this.client.update(id, vmSize(resources, host?.cpus ?? null)).catch((err: unknown) => {
      // One that's never started takes its size when it does.
      if (!(err instanceof BridgeError && err.status === 404)) throw err;
    });
  }

  capacity(): Promise<{ cpus: number; memoryMb: number } | null> {
    return this.client.capacity();
  }

  async activateWindows(id: string, productKey: string): Promise<"activated" | "already"> {
    let said = "";
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        said += chunk.toString("utf8");
        done();
      },
    });
    // On stdin: in no command line or environment the guest's other users might see.
    await this.withGuest(id, (link) =>
      link.runToEnd(
        { command: "product-key", stdin: Readable.from([Buffer.from(productKey)]), stdout: out },
        5 * 60_000,
      ),
    );
    return said.trim() === "already" ? "already" : "activated";
  }

  /** Only a VM that may still be on a tailnet is booted to sign out. */
  async leaveTailnet(id: string): Promise<void> {
    const vm = await this.vm(id);
    if (!vm?.tailscale || vm.guest !== "linux") return;
    await this.withGuest(id, (link) => link.runToEnd({ command: "tailscale-leave" }, 2 * 60_000));
    await this.client.update(id, { tailscale: false });
  }
}

/** How long a home's archive may go without a byte before it's given up on. */
const STALL_MS = 3 * 60_000;
const STALLED = `stalled, with nothing for ${STALL_MS / 60_000} minutes`;

/**
 * A stream that passes everything through and says how much, every half a
 * minute and at its end: a VM's channel to its guest can be slow (a COM
 * port, for Windows), and a big home takes a while over it. Slow is fine;
 * nothing at all for STALL_MS is `stalled`.
 */
function metered(say: (message: string) => void, stalled: () => void): Transform {
  const started = Date.now();
  let bytes = 0;
  let movedAt = Date.now();
  const so = () =>
    `${(bytes / 1_000_000).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)} s`;
  const timer = setInterval(() => {
    say(`${so()} so far`);
    if (Date.now() - movedAt > STALL_MS) {
      // Given up on: it says so once, and stops counting.
      clearInterval(timer);
      stalled();
      meter.destroy(new Error(STALLED));
    }
  }, 30_000);
  timer.unref();
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      movedAt = Date.now();
      done(null, chunk);
    },
  });
  meter.once("close", () => {
    clearInterval(timer);
    say(so());
  });
  return meter;
}
