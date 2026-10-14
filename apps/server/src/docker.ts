import { Readable, Writable } from "node:stream";
import Docker from "dockerode";
import {
  CONTAINER_SSH_AUTH_SOCK,
  DEFAULT_MEMORY_MB,
  defaultResources,
  type Resources,
  type RunnerEnv,
} from "@nibblet/protocol";
import type { Config } from "./config.ts";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";
const NIBBLET = "nibblet.id";

export const runnerName = (nibbletId: string): string => `nibblet-${nibbletId}`;
export const homeVolume = (nibbletId: string): string => `nibblet-home-${nibbletId}`;
/** Docker's limit fields for a nibblet's resources. Swap is capped at the memory limit. */
export function limits(r: Resources): { Memory: number; MemorySwap: number; NanoCpus: number } {
  const memory = (r.memoryMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
  return {
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: r.cpus === null ? 0 : Math.round(r.cpus * 1e9),
  };
}

/** Caches inside a home folder that rebuild themselves, so aren't worth snapshotting. */
const HOME_ARCHIVE_EXCLUDES = [
  "nibblet/.cache",
  "nibblet/.npm/_cacache",
  "nibblet/.config/chromium/*/Cache",
  "nibblet/.config/chromium/*/Code Cache",
  "nibblet/.config/chromium/*/GPUCache",
  "nibblet/.config/chromium/*/Service Worker/CacheStorage",
];

/** The runner image's user home, which holds its working folder. */
const RUNNER_HOME = "/home/nibblet";

/**
 * The server's handle on Docker: runner containers for nibblets and the
 * cloudflared container for tunnels. Everything it creates is labelled, so
 * a restart can find (and tidy up) what an earlier run left behind.
 */
export class Orchestrator {
  readonly docker: Docker;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.docker = new Docker(
      config.DOCKER_SOCKET ? { socketPath: config.DOCKER_SOCKET } : undefined,
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async ensureNetwork(): Promise<void> {
    const name = this.config.NIBBLET_NETWORK;
    const existing = await this.docker.listNetworks({ filters: { name: [name] } });
    if (existing.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Labels: { [MANAGED]: "true" },
    });
  }

  async startRunner(
    nibbletId: string,
    env: RunnerEnv,
    opts: { sshAgent: boolean; resources: Resources } = {
      sshAgent: false,
      resources: defaultResources,
    },
  ): Promise<string> {
    const home = await this.ensureHome(nibbletId);
    await this.carryOverHome(nibbletId, home);
    await this.removeContainer(runnerName(nibbletId));
    const container = await this.docker.createContainer({
      name: runnerName(nibbletId),
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { [MANAGED]: "true", [ROLE]: "runner", [NIBBLET]: nibbletId },
      HostConfig: {
        NetworkMode: this.config.NIBBLET_NETWORK,
        // Chromium wants more shared memory than Docker's 64 MB default.
        ShmSize: 1024 * 1024 * 1024,
        ...limits(opts.resources),
        RestartPolicy: { Name: "no" },
        // Docker Desktop provides this itself; Linux engines need it spelt out.
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // Its home folder (files, browser profile, git and CLI config, agent
        // sessions) lives on a volume of its own, so restarts and image
        // updates never wipe it. Only deleting the nibblet removes it.
        Mounts: [{ Type: "volume", Source: home, Target: RUNNER_HOME }],
        // The host's agent, never its keys: the container can sign, not copy.
        ...(opts.sshAgent && this.config.HOST_SSH_AUTH_SOCK
          ? {
              Binds: [`${this.config.HOST_SSH_AUTH_SOCK}:${CONTAINER_SSH_AUTH_SOCK}`],
              // Docker Desktop and OrbStack forward it as root:root 0660.
              GroupAdd: ["0"],
            }
          : {}),
      },
      NetworkingConfig: {
        EndpointsConfig: { [this.config.NIBBLET_NETWORK]: { Aliases: [runnerName(nibbletId)] } },
      },
    });
    await container.start();
    return container.id;
  }

  /**
   * Runs a command to completion in a throwaway runner container, with
   * `stdin` piped in. For short jobs that need the runner image's tools, such
   * as listing OpenCode's models exactly as a nibblet would see them.
   */
  async runOnce(
    cmd: string[],
    stdin: string,
    timeoutMs = 90_000,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const container = await this.docker.createContainer({
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Cmd: cmd,
      Labels: { [MANAGED]: "true", [ROLE]: "oneshot" },
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      HostConfig: {
        NetworkMode: this.config.NIBBLET_NETWORK,
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    try {
      const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const collect = (into: Buffer[]) =>
        new Writable({
          write(chunk: Buffer, _enc, done) {
            into.push(chunk);
            done();
          },
        });
      this.docker.modem.demuxStream(stream, collect(out), collect(err));
      const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()));
      await container.start();
      stream.end(stdin);
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), timeoutMs).unref(),
      );
      const result: { StatusCode: number } = await Promise.race([container.wait(), timer]);
      await Promise.race([ended, new Promise((r) => setTimeout(r, 1000))]);
      return {
        code: result.StatusCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * Whether a nibblet's container was made from an older build of the runner
   * image than the one tagged now, so it's missing fixes until it's recreated.
   */
  async runnerOutdated(nibbletId: string): Promise<boolean> {
    try {
      const [container, image] = await Promise.all([
        this.docker.getContainer(runnerName(nibbletId)).inspect(),
        this.docker.getImage(this.config.NIBBLET_RUNNER_IMAGE).inspect(),
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
      const host = await this.hostCapacity();
      if (host) fields.NanoCpus = host.cpus * 1e9;
    }
    try {
      await this.docker.getContainer(runnerName(nibbletId)).update(fields);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /** The CPUs and memory Docker can hand out, for sizing limits in the UI. */
  async hostCapacity(): Promise<{ cpus: number; memoryMb: number } | null> {
    try {
      const info = await this.docker.info();
      return { cpus: info.NCPU, memoryMb: Math.floor(info.MemTotal / 1024 / 1024) };
    } catch {
      return null;
    }
  }

  /** The nibblet's home volume, created on first use. */
  private async ensureHome(nibbletId: string): Promise<string> {
    const name = homeVolume(nibbletId);
    try {
      await this.docker.getVolume(name).inspect();
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.docker.createVolume({
        Name: name,
        Labels: { [MANAGED]: "true", [ROLE]: "home", [NIBBLET]: nibbletId },
      });
    }
    return name;
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
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Entrypoint: ["true"],
      Labels: { [MANAGED]: "true", [ROLE]: "home-copy", [NIBBLET]: nibbletId },
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
      await this.inHome(
        volume,
        [
          "tar",
          "-C",
          "/home",
          "-czf",
          "-",
          ...HOME_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`),
          "nibblet",
        ],
        { readOnly: true, stdout: out },
      );
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
    await this.inHome(
      volume,
      ["sh", "-c", `find ${RUNNER_HOME} -mindepth 1 -delete && tar -C /home -xzpf -`],
      { readOnly: false, stdin: archive },
    );
  }

  /** Runs a command as root in a throwaway container with the home volume mounted, offline. */
  private async inHome(
    volume: string,
    cmd: string[],
    io: { readOnly: boolean; stdin?: Readable; stdout?: Writable },
  ): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      User: "0",
      Cmd: cmd,
      Labels: { [MANAGED]: "true", [ROLE]: "home-snapshot" },
      AttachStdin: io.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: io.stdin !== undefined,
      StdinOnce: io.stdin !== undefined,
      Tty: false,
      HostConfig: {
        NetworkMode: "none",
        Mounts: [{ Type: "volume", Source: volume, Target: RUNNER_HOME, ReadOnly: io.readOnly }],
      },
    });
    try {
      const stream = await container.attach({
        stream: true,
        stdin: io.stdin !== undefined,
        stdout: true,
        stderr: true,
        hijack: true,
      });
      const stderr: Buffer[] = [];
      const sink = (into: Buffer[] | null) =>
        new Writable({
          write(chunk: Buffer, _enc, done) {
            into?.push(chunk);
            done();
          },
        });
      const out = io.stdout ?? sink(null);
      this.docker.modem.demuxStream(stream, out, sink(stderr));
      const ended = new Promise<void>((resolve) => stream.once("end", () => resolve()));
      await container.start();
      // Ending the attach stream closes the container's stdin, so tar sees the end.
      io.stdin?.pipe(stream);
      const result: { StatusCode: number } = await container.wait();
      await Promise.race([ended, new Promise((r) => setTimeout(r, 2000))]);
      if (result.StatusCode !== 0) {
        throw new Error(
          `${cmd[0]} exited ${result.StatusCode}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 500)}`,
        );
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /** Deletes a nibblet's home volume; only for when the nibblet itself is deleted. */
  async removeHome(nibbletId: string): Promise<void> {
    try {
      await this.docker.getVolume(homeVolume(nibbletId)).remove();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async stopRunner(nibbletId: string): Promise<void> {
    await this.carryOverHome(nibbletId, await this.ensureHome(nibbletId));
    await this.removeContainer(runnerName(nibbletId));
  }

  /** Nibblet ids with a runner container, and whether it is running. */
  async runners(): Promise<Map<string, { id: string; running: boolean }>> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED}=true`, `${ROLE}=runner`] },
    });
    const out = new Map<string, { id: string; running: boolean }>();
    for (const c of list) {
      const nibbletId = c.Labels[NIBBLET];
      if (nibbletId) out.set(nibbletId, { id: c.Id, running: c.State === "running" });
    }
    return out;
  }

  async runnerLogs(nibbletId: string, tail = 200): Promise<string> {
    try {
      const buf = await this.docker
        .getContainer(runnerName(nibbletId))
        .logs({ stdout: true, stderr: true, tail });
      // Non-TTY logs are framed with an 8-byte header per chunk; strip them.
      const chunks: string[] = [];
      let i = 0;
      while (i + 8 <= buf.length) {
        const size = buf.readUInt32BE(i + 4);
        chunks.push(buf.subarray(i + 8, i + 8 + size).toString("utf8"));
        i += 8 + size;
      }
      return chunks.join("");
    } catch {
      return "";
    }
  }

  /** Calls back with the nibblet id whenever one of its containers stops. */
  async watchRunnerExits(
    onExit: (nibbletId: string, exitCode: number | null) => void,
  ): Promise<void> {
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
        if (!event?.nibbletId) continue;
        // Ours to remove: its death is expected, whatever the nibblet's status says by now.
        if (event.containerId && this.removing.has(event.containerId)) continue;
        onExit(event.nibbletId, event.exitCode);
      }
    });
  }

  /** Containers this server is removing on purpose, so their exit events can be ignored. */
  private readonly removing = new Set<string>();

  async removeContainer(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      const { Id } = await container.inspect();
      this.removing.add(Id);
      // The die event arrives within moments; this only keeps the set small.
      setTimeout(() => this.removing.delete(Id), 5 * 60_000).unref();
      await container.remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}

export function parseDockerEvent(line: string): {
  nibbletId: string | undefined;
  containerId: string | undefined;
  exitCode: number | null;
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
    };
  } catch {
    return null;
  }
}
