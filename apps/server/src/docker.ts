import { Writable } from "node:stream";
import Docker from "dockerode";
import { CONTAINER_SSH_AUTH_SOCK, type RunnerEnv } from "@nibblet/protocol";
import type { Config } from "./config.ts";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";
const NIBBLET = "nibblet.id";

export const runnerName = (nibbletId: string): string => `nibblet-${nibbletId}`;

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
    opts: { sshAgent: boolean } = { sshAgent: false },
  ): Promise<string> {
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
        Memory: 4 * 1024 * 1024 * 1024,
        RestartPolicy: { Name: "no" },
        // Docker Desktop provides this itself; Linux engines need it spelt out.
        ExtraHosts: ["host.docker.internal:host-gateway"],
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

  async stopRunner(nibbletId: string): Promise<void> {
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
        if (event?.nibbletId) onExit(event.nibbletId, event.exitCode);
      }
    });
  }

  async removeContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

export function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}

function parseDockerEvent(
  line: string,
): { nibbletId: string | undefined; exitCode: number | null } | null {
  try {
    const parsed: { Actor?: { Attributes?: Record<string, string> } } = JSON.parse(line);
    const attrs = parsed.Actor?.Attributes ?? {};
    const code = attrs.exitCode === undefined ? null : Number(attrs.exitCode);
    return { nibbletId: attrs[NIBBLET], exitCode: code };
  } catch {
    return null;
  }
}
