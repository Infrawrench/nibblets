import Docker from "dockerode";
import type { RunnerEnv } from "@nibblet/protocol";
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

  async startRunner(nibbletId: string, env: RunnerEnv): Promise<string> {
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
      },
      NetworkingConfig: {
        EndpointsConfig: { [this.config.NIBBLET_NETWORK]: { Aliases: [runnerName(nibbletId)] } },
      },
    });
    await container.start();
    return container.id;
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
