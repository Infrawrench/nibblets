import { posix } from "node:path";
import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import Docker from "dockerode";
import {
  safeId,
  SUBAGENT_COMMAND,
  TAILSCALE_LEAVE_COMMAND,
  type ExitListener,
  type MachineEnv,
  type MachinePlugin,
  type MachineSpec,
  type MachineState,
  type SubagentExit,
} from "@nibblet/machine";
import {
  CONTAINER_SSH_AUTH_SOCK,
  CONTAINER_TAILSCALE_STATE,
  DEFAULT_MEMORY_MB,
  HARNESS_CLI_DIR,
  HARNESS_CLI_VOLUME,
  HOME_ARCHIVE_EXCLUDES,
  type GuestOs,
  type MachineBackend,
  type MachineCapabilities,
  type Resources,
} from "@nibblet/protocol";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";
const NIBBLET = "nibblet.id";
/**
 * Which server's it is, so two on one engine (a test stack beside a real
 * one) each tidy up only their own. Made before there were stacks, it has
 * none, and is the default's.
 */
const STACK = "nibblet.stack";
export const DEFAULT_STACK = "nibblet";

export const runnerName = (nibbletId: string): string => `nibblet-${nibbletId}`;
export const homeVolume = (nibbletId: string): string => `nibblet-home-${nibbletId}`;
/** Tailscale's state, out of the agent's reach (and out of snapshots, which are of its home). */
export const tailscaleVolume = (nibbletId: string): string => `nibblet-tailscale-${nibbletId}`;

/** Docker's limit fields for a nibblet's resources. Swap is capped at the memory limit. */
export function limits(r: Resources): { Memory: number; MemorySwap: number; NanoCpus: number } {
  const memory = (r.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
  return {
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: r.cpus === null ? 0 : Math.round(r.cpus * 1e9),
  };
}

/**
 * How a runner container is locked down. Its entry runs as root only to set
 * the firewall and folders, with just the capabilities for that, then starts
 * the guard and the agent as users with none; no-new-privileges stops anything
 * regaining one. The process limit keeps a runaway agent from starving the host.
 */
export const RUNNER_HARDENING = {
  CapDrop: ["ALL"],
  CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL", "NET_ADMIN", "NET_RAW"],
  SecurityOpt: ["no-new-privileges:true"],
  PidsLimit: 4096,
};

/** The runner image's user home, which holds its working folder. */
const RUNNER_HOME = "/home/nibblet";
/** The folder the browser profile (`chromium/`) sits in, inside the guard's home. */
const PROFILE_PARENT = `${RUNNER_HOME}/.guard/.config`;
/** The guard owns its home and profile (uid:gid from the runner image). */
const GUARD_OWNER = "1100:1100";
/** Caches in the profile that rebuild themselves, so aren't worth borrowing. */
const PROFILE_ARCHIVE_EXCLUDES = [
  "chromium/*/Cache",
  "chromium/*/Code Cache",
  "chromium/*/GPUCache",
  "chromium/*/Service Worker/CacheStorage",
];
/** Where a sub-agent's entry leaves its pid in its host's container (SUBAGENT_PIDS in the runner). */
const SUBAGENT_PIDS = "/run/nibblet-subagents";
const ENTRY = "/app/apps/runner/src/entry.ts";
/** What `docker stop` gives a runner: past the entry's own 10-second wait. */
export const RUNNER_STOP_SECONDS = 12;

const CAPABILITIES: MachineCapabilities = {
  browser: true,
  tailscale: true,
  sshAgent: true,
  liveResources: true,
  localSignIn: true,
};

export interface DockerMachinesOptions {
  docker: Docker;
  /** The network runners join: the server and the credential proxy are on it, the database isn't. */
  network: string;
  runnerImage: string;
  /** The host's SSH agent socket as the engine sees it; empty turns sharing it off. */
  hostSshAuthSock: string;
  /** Which stack's containers are its own; `nibblet` unless there's more than one. */
  stack?: string;
}

/**
 * Containers on the stack's own Docker engine: the recommended machine.
 * Everything it creates is labelled, so a restart can find (and tidy up)
 * what an earlier run left behind.
 */
export class DockerMachines implements MachinePlugin {
  readonly id = "docker";
  readonly name = "Docker";
  readonly kind = "container";
  readonly docker: Docker;
  private readonly opts: DockerMachinesOptions;
  /** Containers this plugin is removing on purpose, so their exit events can be ignored. */
  private readonly removing = new Set<string>();

  constructor(opts: DockerMachinesOptions) {
    this.opts = opts;
    this.docker = opts.docker;
  }

  async describe(): Promise<MachineBackend> {
    const base: Pick<MachineBackend, "id" | "name" | "kind" | "recommended"> = {
      id: this.id,
      name: this.name,
      kind: this.kind,
      recommended: true,
    };
    try {
      await this.docker.ping();
    } catch (err) {
      return {
        ...base,
        available: false,
        detail: `Docker isn't answering: ${err instanceof Error ? err.message : String(err)}`,
        guests: [],
      };
    }
    const image = await this.docker
      .getImage(this.opts.runnerImage)
      .inspect()
      .then(() => true)
      .catch(() => false);
    return {
      ...base,
      available: true,
      detail: null,
      guests: [
        {
          os: "linux",
          image: {
            state: image ? "ready" : "missing",
            detail: image ? null : `${this.opts.runnerImage} hasn't been pulled or built`,
            progress: null,
            source: "none",
          },
          capabilities: CAPABILITIES,
        },
      ],
    };
  }

  capabilities(_guest: GuestOs): MachineCapabilities {
    return CAPABILITIES;
  }

  /** The runner image comes with the stack: pulled or built alongside the server. */
  async prepare(): Promise<void> {}

  async start(nibbletId: string, spec: MachineSpec): Promise<string> {
    if (spec.machine.guest !== "linux") throw new Error("Containers only run Linux");
    const home = await this.ensureHome(nibbletId);
    // Mounted while it's on the tailnet, and after, so its entry can sign the machine out.
    const tailscale = spec.tailscale
      ? await this.ensureVolume(tailscaleVolume(nibbletId), "tailscale", nibbletId)
      : (await this.volumeExists(tailscaleVolume(nibbletId)))
        ? tailscaleVolume(nibbletId)
        : null;
    await this.carryOverHome(nibbletId, home);
    await this.removeContainer(runnerName(nibbletId), { graceful: true });
    const container = await this.docker.createContainer({
      name: runnerName(nibbletId),
      Image: this.opts.runnerImage,
      Env: envList(spec.env),
      Labels: {
        [MANAGED]: "true",
        [STACK]: this.opts.stack ?? DEFAULT_STACK,
        [ROLE]: "runner",
        [NIBBLET]: nibbletId,
      },
      HostConfig: {
        NetworkMode: this.opts.network,
        // Chromium wants more shared memory than Docker's 64 MB default.
        ShmSize: 1024 * 1024 * 1024,
        ...limits(spec.resources),
        RestartPolicy: { Name: "no" },
        ...RUNNER_HARDENING,
        // Docker Desktop provides this itself; Linux engines need it spelt out.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // Its home folder (files, browser profile, git and CLI config, agent
        // sessions) lives on a volume of its own, so restarts and image
        // updates never wipe it. Only deleting the nibblet removes it.
        // Newer harness CLIs the server installed, read-only: see HarnessUpdater.
        Mounts: [
          { Type: "volume", Source: home, Target: RUNNER_HOME },
          { Type: "volume", Source: HARNESS_CLI_VOLUME, Target: HARNESS_CLI_DIR, ReadOnly: true },
          ...(tailscale
            ? [{ Type: "volume" as const, Source: tailscale, Target: CONTAINER_TAILSCALE_STATE }]
            : []),
        ],
        // The host's agent, never its keys: the container can sign, not copy.
        ...(spec.sshAgent && this.opts.hostSshAuthSock
          ? {
              Binds: [`${this.opts.hostSshAuthSock}:${CONTAINER_SSH_AUTH_SOCK}`],
              // Docker Desktop and OrbStack forward it as root:root 0660.
              GroupAdd: ["0"],
            }
          : {}),
      },
      NetworkingConfig: {
        EndpointsConfig: { [this.opts.network]: { Aliases: [runnerName(nibbletId)] } },
      },
    });
    await container.start();
    return container.id;
  }

  /** Whether a nibblet's own container is up. */
  async running(nibbletId: string): Promise<boolean> {
    try {
      return (await this.docker.getContainer(runnerName(nibbletId)).inspect()).State.Running;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** On the runners' network, by its alias. */
  async address(nibbletId: string, port: number): Promise<string> {
    return `${runnerName(nibbletId)}:${port}`;
  }

  /**
   * Starts a sub-agent in the container of the nibblet it works for (`hostId`):
   * its own guard and runner beside the host's, sharing its files, tools and
   * servers (see the runner's entry). `onExit` is called with the end of its
   * output when they stop, whether on their own or with the container.
   */
  async startSubagent(
    hostId: string,
    _nibbletId: string,
    env: MachineEnv,
    onExit: SubagentExit,
  ): Promise<void> {
    const container = this.docker.getContainer(runnerName(hostId));
    const exec = await container.exec({
      Cmd: ["node", ENTRY, SUBAGENT_COMMAND],
      // Root, as the container's own entry: it splits into the guard and the agent.
      User: "0",
      Env: envList(env),
      WorkingDir: `${RUNNER_HOME}/work`,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    // Its last lines, in place of a container's logs, for saying why it stopped.
    let tail = "";
    const keep = new Writable({
      write(chunk: Buffer, _enc, done) {
        tail = (tail + chunk.toString("utf8")).slice(-4000);
        done();
      },
    });
    this.docker.modem.demuxStream(stream, keep, keep);
    stream.once("end", () => {
      void exec
        .inspect()
        .then((info) => info.ExitCode ?? null)
        .catch(() => null)
        .then((code) => onExit(code, tail));
    });
  }

  /** Stops a sub-agent started with startSubagent, giving its tasks their time to finish. */
  async stopSubagent(hostId: string, nibbletId: string): Promise<void> {
    await this.inRunner(hostId, ["sh", "-c", stopSubagentScript()], { SUBAGENT: nibbletId });
  }

  /**
   * Deletes what a sub-agent kept in its host's home: its harness's state and
   * its browser profile, with its logins. In the host's container when it's
   * up, or straight from its home volume when it isn't.
   */
  async removeSubagentState(hostId: string, nibbletId: string): Promise<void> {
    const cmd = ["rm", "-rf", ...subagentStatePaths(RUNNER_HOME, nibbletId)];
    if (await this.inRunner(hostId, cmd, {})) return;
    await this.inHome(await this.ensureHome(hostId), cmd, { readOnly: false });
  }

  /**
   * Runs a command as root in a nibblet's running container, to completion.
   * False, without running it, if the container isn't up; throws if it fails.
   */
  private async inRunner(
    nibbletId: string,
    cmd: string[],
    env: Record<string, string>,
  ): Promise<boolean> {
    if (!(await this.running(nibbletId))) return false;
    const exec = await this.docker.getContainer(runnerName(nibbletId)).exec({
      Cmd: cmd,
      User: "0",
      Env: envList(env),
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    stream.resume();
    await new Promise<void>((resolve) => {
      stream.once("end", () => resolve());
      stream.once("close", () => resolve());
    });
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0 && ExitCode !== null) throw new Error(`${cmd[0]} exited ${ExitCode}`);
    return true;
  }

  /**
   * Whether a nibblet's container was made from an older build of the runner
   * image than the one tagged now, so it's missing fixes until it's recreated.
   */
  async outdated(nibbletId: string): Promise<boolean> {
    try {
      const [container, image] = await Promise.all([
        this.docker.getContainer(runnerName(nibbletId)).inspect(),
        this.docker.getImage(this.opts.runnerImage).inspect(),
      ]);
      return container.Image !== image.Id;
    } catch {
      return false;
    }
  }

  /** Changes a running nibblet's limits in place; Docker applies them without a restart. */
  async applyResources(nibbletId: string, resources: Resources): Promise<void> {
    // Docker ignores "0 CPUs" on a running container, so lifting a cap means
    // setting it to every CPU there is.
    const fields = limits(resources);
    if (resources.cpus === null) {
      const host = await this.capacity();
      if (host) fields.NanoCpus = host.cpus * 1e9;
    }
    try {
      await this.docker.getContainer(runnerName(nibbletId)).update(fields);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** The CPUs and memory Docker can hand out, for sizing limits in the UI. */
  async capacity(): Promise<{ cpus: number; memoryMb: number } | null> {
    try {
      const info = await this.docker.info();
      return { cpus: info.NCPU, memoryMb: Math.floor(info.MemTotal / 1024 / 1024) };
    } catch {
      return null;
    }
  }

  /** The nibblet's home volume, created on first use. */
  private ensureHome(nibbletId: string): Promise<string> {
    return this.ensureVolume(homeVolume(nibbletId), "home", nibbletId);
  }

  private async ensureVolume(name: string, role: string, nibbletId: string): Promise<string> {
    if (await this.volumeExists(name)) return name;
    await this.docker.createVolume({
      Name: name,
      Labels: {
        [MANAGED]: "true",
        [STACK]: this.opts.stack ?? DEFAULT_STACK,
        [ROLE]: role,
        [NIBBLET]: nibbletId,
      },
    });
    return name;
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return false;
    }
  }

  /**
   * Containers made before homes were volumes kept their files inside the
   * container. Before one of those is replaced, its home folder is copied
   * into the new volume, so nothing it had is lost on the way.
   */
  private async carryOverHome(nibbletId: string, volume: string): Promise<void> {
    const old = this.docker.getContainer(runnerName(nibbletId));
    let mounts: { Destination?: string }[];
    try {
      mounts = (await old.inspect()).Mounts ?? [];
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    if (mounts.some((m) => m.Destination === RUNNER_HOME)) return;
    const archive = await old.getArchive({ path: RUNNER_HOME });
    // A stopped helper with the volume mounted is enough to unpack into it.
    const helper = await this.docker.createContainer({
      Image: this.opts.runnerImage,
      Entrypoint: ["true"],
      Labels: {
        [MANAGED]: "true",
        [STACK]: this.opts.stack ?? DEFAULT_STACK,
        [ROLE]: "home-copy",
        [NIBBLET]: nibbletId,
      },
      HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: RUNNER_HOME }] },
    });
    try {
      await helper.putArchive(archive, { path: "/home" });
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * Writes a nibblet's home folder, as a gzipped tar, to `out`. A running
   * runner is paused for the copy so files aren't caught half-written;
   * caches that rebuild themselves are left out.
   */
  async archiveHome(nibbletId: string, out: Writable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    const runner = this.docker.getContainer(runnerName(nibbletId));
    const paused = await runner
      .pause()
      .then(() => true)
      .catch(() => false);
    try {
      await this.inHome(volume, archiveHomeCommand("/home"), { readOnly: true, stdout: out });
    } finally {
      if (paused) await runner.unpause().catch(() => undefined);
    }
  }

  /**
   * Replaces a nibblet's home folder with an archive from `archiveHome`. The
   * runner must be stopped first: this empties the folder before unpacking.
   */
  async restoreHome(nibbletId: string, archive: Readable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    await this.inHome(volume, restoreHomeCommand(RUNNER_HOME), {
      readOnly: false,
      stdin: archive,
    });
  }

  /**
   * Writes just the browser profile (the guard's `~/.config/chromium`), as a
   * gzipped tar rooted at `chromium/`, to `out`. The nibblet must be stopped
   * first (a borrow stops it), so nothing is browsing while it's copied; the
   * caches that rebuild themselves are left out. An empty profile is made if
   * the nibblet never browsed, so the window still opens.
   */
  async archiveProfile(nibbletId: string, out: Writable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    // Quoted: "Code Cache" has a space, and the shell would split it.
    const excludes = PROFILE_ARCHIVE_EXCLUDES.map((e) => `'--exclude=${e}'`).join(" ");
    await this.inHome(
      volume,
      [
        "sh",
        "-c",
        // The folders it makes are the guard's, as they'd be had its browser made them.
        `mkdir -p ${PROFILE_PARENT}/chromium && ` +
          `chown ${GUARD_OWNER} ${PROFILE_PARENT} ${PROFILE_PARENT}/chromium && ` +
          `cd ${PROFILE_PARENT} && tar --numeric-owner ${excludes} -czf - chromium`,
      ],
      { readOnly: false, stdout: out },
    );
  }

  /**
   * Replaces the browser profile from a tar made by `archiveProfile` (rooted
   * at `chromium/`), handing ownership back to the guard. The tar is
   * unpacked beside the profile first and swapped in only once it's whole,
   * so a broken or cut-off handback leaves the old profile as it was. The
   * nibblet must be stopped; its guard clears any stale profile lock when it
   * starts again.
   */
  async restoreProfile(nibbletId: string, archive: Readable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    const incoming = `${PROFILE_PARENT}/.chromium-incoming`;
    const old = `${PROFILE_PARENT}/.chromium-old`;
    await this.inHome(
      volume,
      [
        "sh",
        "-c",
        [
          "set -e",
          `mkdir -p ${PROFILE_PARENT}`,
          `rm -rf ${incoming} ${old}`,
          `mkdir ${incoming}`,
          `if ! tar -C ${incoming} --no-same-owner -xzf - || [ ! -d ${incoming}/chromium ]; then`,
          `  rm -rf ${incoming}; echo "the handed-back profile was incomplete" >&2; exit 1`,
          "fi",
          `chown -R ${GUARD_OWNER} ${incoming}/chromium`,
          `chown ${GUARD_OWNER} ${PROFILE_PARENT}`,
          `if [ -e ${PROFILE_PARENT}/chromium ]; then mv ${PROFILE_PARENT}/chromium ${old}; fi`,
          `mv ${incoming}/chromium ${PROFILE_PARENT}/chromium`,
          `rm -rf ${incoming} ${old}`,
        ].join("\n"),
      ],
      { readOnly: false, stdin: archive },
    );
  }

  /**
   * Runs a command as root in a throwaway container with the home volume
   * mounted, offline. It's an exec in an idle container rather than the
   * container's own command: attaching to that sends Podman the request's
   * body as the start of stdin, where an exec's stdin is only what's piped.
   */
  async inHome(
    volume: string,
    cmd: string[],
    io: { readOnly: boolean; stdin?: Readable; stdout?: Writable },
  ): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.opts.runnerImage,
      User: "0",
      Cmd: ["sleep", "infinity"],
      Labels: {
        [MANAGED]: "true",
        [STACK]: this.opts.stack ?? DEFAULT_STACK,
        [ROLE]: "home-snapshot",
      },
      HostConfig: {
        NetworkMode: "none",
        Mounts: [{ Type: "volume", Source: volume, Target: RUNNER_HOME, ReadOnly: io.readOnly }],
      },
    });
    try {
      await container.start();
      const exec = await container.exec({
        Cmd: cmd,
        User: "0",
        AttachStdin: io.stdin !== undefined,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: io.stdin !== undefined });
      const stderr: Buffer[] = [];
      const sink = (into: Buffer[] | null) =>
        new Writable({
          write(chunk: Buffer, _enc, done) {
            into?.push(chunk);
            done();
          },
        });
      this.docker.modem.demuxStream(stream, io.stdout ?? sink(null), sink(stderr));
      const ended = new Promise<void>((resolve) => {
        stream.once("end", () => resolve());
        stream.once("close", () => resolve());
      });
      // Ending the stream closes the command's stdin, so tar sees the end.
      // A source that fails part-way never ends it, so the connection is
      // dropped instead, and the command fails, rather than waiting forever.
      io.stdin?.once("error", () => stream.destroy());
      io.stdin?.pipe(stream);
      await ended;
      const code = await exitOf(exec);
      if (code !== 0) {
        throw new Error(
          `${cmd[0]} exited ${code ?? "without a code"}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 500)}`,
        );
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /** Deletes a nibblet's home volume, and Tailscale's; only for when the nibblet itself is deleted. */
  async removeHome(nibbletId: string): Promise<void> {
    for (const name of [homeVolume(nibbletId), tailscaleVolume(nibbletId)]) {
      try {
        await this.docker.getVolume(name).remove();
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  /**
   * Signs out the machine a nibblet left on the tailnet, while its own
   * container is down: the runner image's entry, with nothing but its
   * Tailscale volume, fenced off like a runner. Nothing to do without the volume.
   */
  async leaveTailnet(nibbletId: string): Promise<void> {
    const volume = tailscaleVolume(nibbletId);
    if (!(await this.volumeExists(volume))) return;
    const container = await this.docker.createContainer({
      Image: this.opts.runnerImage,
      Cmd: ["node", ENTRY, TAILSCALE_LEAVE_COMMAND],
      Labels: {
        [MANAGED]: "true",
        [STACK]: this.opts.stack ?? DEFAULT_STACK,
        [ROLE]: "tailscale-leave",
        [NIBBLET]: nibbletId,
      },
      HostConfig: {
        NetworkMode: this.opts.network,
        ...RUNNER_HARDENING,
        Mounts: [{ Type: "volume", Source: volume, Target: CONTAINER_TAILSCALE_STATE }],
      },
    });
    try {
      await container.start();
      await Promise.race([
        container.wait(),
        new Promise((resolve) => setTimeout(resolve, 60_000).unref()),
      ]);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async stop(nibbletId: string): Promise<void> {
    await this.carryOverHome(nibbletId, await this.ensureHome(nibbletId));
    await this.removeContainer(runnerName(nibbletId), { graceful: true });
  }

  discard(nibbletId: string): Promise<void> {
    return this.removeContainer(runnerName(nibbletId));
  }

  /** Whether something with these labels is this stack's. */
  private ours(labels: Record<string, string | undefined>): boolean {
    return (labels[STACK] ?? DEFAULT_STACK) === (this.opts.stack ?? DEFAULT_STACK);
  }

  /** Nibblet ids with a runner container, and whether it is running. */
  async machines(): Promise<Map<string, MachineState>> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED}=true`, `${ROLE}=runner`] },
    });
    const out = new Map<string, MachineState>();
    for (const c of list) {
      if (!this.ours(c.Labels)) continue;
      const nibbletId = c.Labels[NIBBLET];
      if (nibbletId) out.set(nibbletId, { id: c.Id, running: c.State === "running" });
    }
    return out;
  }

  async logs(nibbletId: string, tail = 200): Promise<string> {
    try {
      const buf = await this.docker
        .getContainer(runnerName(nibbletId))
        .logs({ stdout: true, stderr: true, tail });
      return unframeLogs(buf);
    } catch {
      return "";
    }
  }

  /** Calls back with the nibblet id whenever one of its containers stops. */
  async watchExits(onExit: ExitListener): Promise<void> {
    const stream = await this.docker.getEvents({
      filters: {
        type: ["container"],
        event: ["die"],
        label: [`${MANAGED}=true`, `${ROLE}=runner`],
      },
    });
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const event = parseDockerEvent(line);
        if (!event?.nibbletId || !this.ours({ [STACK]: event.stack })) continue;
        // Ours to remove: its death is expected, whatever the nibblet's status says by now.
        if (event.containerId && this.removing.has(event.containerId)) continue;
        onExit(event.nibbletId, event.exitCode);
      }
    });
  }

  /**
   * `graceful`: stop it first, so what runs inside gets SIGTERM and a few
   * seconds to finish (a runner's background tasks, saving a game world)
   * rather than being killed outright.
   */
  async removeContainer(name: string, opts: { graceful?: boolean } = {}): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      const { Id, State } = await container.inspect();
      this.removing.add(Id);
      // The die event arrives within moments; this only keeps the set small.
      setTimeout(() => this.removing.delete(Id), 5 * 60_000).unref();
      if (opts.graceful && State?.Running)
        await container.stop({ t: RUNNER_STOP_SECONDS }).catch(() => undefined);
      await container.remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/** Docker wants `KEY=value` strings. */
function envList(env: MachineEnv): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

/**
 * Stops the sub-agent named by `$SUBAGENT` in its host's machine: SIGTERM
 * to the pid its entry left, then SIGKILL once its tasks have had their
 * time. The id comes in the environment, not the script. Shared by every
 * Linux machine.
 */
export function stopSubagentScript(): string {
  return `f="${SUBAGENT_PIDS}/$SUBAGENT.pid"; pid=$(cat "$f" 2>/dev/null) || exit 0
kill -TERM "$pid" 2>/dev/null || exit 0
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt ${RUNNER_STOP_SECONDS * 4} ]; do sleep 0.25; i=$((i+1)); done
kill -KILL "$pid" 2>/dev/null; true`;
}

/** Where a sub-agent keeps its harness's state and its browser profile, under its host's home. */
export function subagentStatePaths(home: string, nibbletId: string): string[] {
  const id = safeId(nibbletId);
  return [`${home}/.subagents/${id}`, `${home}/.guard/subagents/${id}`];
}

/** An exec's exit code, once the engine has it: its output can end a moment before it's said. */
async function exitOf(exec: Docker.Exec): Promise<number | null> {
  for (let i = 0; i < 50; i++) {
    const info = await exec.inspect();
    if (!info.Running) return info.ExitCode ?? null;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** `tar` of the `nibblet` folder in `parent`, gzipped to stdout, without the caches. */
export function archiveHomeCommand(parent: string): string[] {
  return [
    "tar",
    "-C",
    parent,
    "-czf",
    "-",
    ...HOME_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`),
    "nibblet",
  ];
}

/** Empties `home` and unpacks an archive from stdin over it. */
export function restoreHomeCommand(home: string): string[] {
  return ["sh", "-c", `find ${home} -mindepth 1 -delete && tar -C ${posix.dirname(home)} -xzpf -`];
}

/** Non-TTY logs are framed with an 8-byte header per chunk; strips them. */
export function unframeLogs(buf: Buffer): string {
  const chunks: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    chunks.push(buf.subarray(i + 8, i + 8 + size).toString("utf8"));
    i += 8 + size;
  }
  return chunks.join("");
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}

export function parseDockerEvent(line: string): {
  nibbletId: string | undefined;
  containerId: string | undefined;
  exitCode: number | null;
  stack: string | undefined;
} | null {
  try {
    const parsed: { id?: string; Actor?: { ID?: string; Attributes?: Record<string, string> } } =
      JSON.parse(line);
    const attrs = parsed.Actor?.Attributes ?? {};
    const code = attrs.exitCode === undefined ? null : Number(attrs.exitCode);
    return {
      nibbletId: attrs[NIBBLET],
      containerId: parsed.Actor?.ID ?? parsed.id,
      exitCode: code,
      stack: attrs[STACK],
    };
  } catch {
    return null;
  }
}
