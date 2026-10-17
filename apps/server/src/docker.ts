import { Writable } from "node:stream";
import Docker from "dockerode";
import { DockerMachines, isNotFound } from "@nibblet/machine-docker";
import { HARNESS_CLI_DIR, HARNESS_CLI_VOLUME } from "@nibblet/protocol";
import type { Config } from "./config.ts";
import { TUNNEL_IMAGE } from "./tunnel.ts";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";

/**
 * The server's handle on the stack's Docker engine, for what isn't a
 * nibblet's machine (those are `DockerMachines`, a machine plugin): the
 * runners' network, throwaway runner containers for short jobs, the
 * cloudflared container for tunnels, and tidying up old images.
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

  /** The machine plugin for nibblets' containers, on this engine. */
  machines(): DockerMachines {
    return new DockerMachines({
      docker: this.docker,
      network: this.config.NIBBLET_NETWORK,
      runnerImage: this.config.NIBBLET_RUNNER_IMAGE,
      hostSshAuthSock: this.config.HOST_SSH_AUTH_SOCK,
    });
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

  /**
   * Runs a command to completion in a throwaway runner container, with
   * `stdin` piped in. For short jobs that need the runner image's tools, such
   * as listing OpenCode's models exactly as a nibblet would see them.
   */
  async runOnce(
    cmd: string[],
    stdin: string,
    timeoutMs = 90_000,
    opts: { root?: boolean; mounts?: { Type: "volume"; Source: string; Target: string }[] } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const container = await this.docker.createContainer({
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Cmd: cmd,
      ...(opts.root ? { User: "0" } : {}),
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
        ...(opts.mounts ? { Mounts: opts.mounts } : {}),
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
   * Runs the runner image's harness CLI installer (apps/runner/src/harness-cli.ts)
   * with the shared volume writable, and returns what it printed as JSON.
   */
  async harnessCli(args: string[], timeoutMs = 15 * 60_000): Promise<unknown> {
    const { code, stdout, stderr } = await this.runOnce(
      ["node", "/app/apps/runner/src/harness-cli.ts", ...args],
      "",
      timeoutMs,
      {
        root: true,
        mounts: [{ Type: "volume", Source: HARNESS_CLI_VOLUME, Target: HARNESS_CLI_DIR }],
      },
    );
    if (code !== 0) {
      const reason = stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
      throw new Error(reason);
    }
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
  }

  /**
   * Removes the images earlier releases and builds left behind: our own
   * (server, runner, credential proxy) under any other tag, untagged leftovers
   * of rebuilds, and cloudflared versions we've moved on from. Docker refuses
   * to remove one a container still uses, so an outdated nibblet keeps its
   * image until it's recreated, and a later run picks it up.
   */
  async pruneImages(): Promise<string[]> {
    const current = currentImages(this.config.NIBBLET_RUNNER_IMAGE);
    if (!current) return [];
    let images: Docker.ImageInfo[];
    let since: number;
    try {
      images = await this.docker.listImages();
      since =
        images.find((i) => i.RepoTags?.includes(this.config.NIBBLET_RUNNER_IMAGE))?.Created ?? 0;
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const ref of staleImages(images, current, since)) {
      try {
        await this.docker.getImage(ref).remove();
        removed.push(ref);
      } catch {
        // In use, or already gone.
      }
    }
    return removed;
  }

  /** Removes a container of the stack's (the tunnel's), if it's there, whatever it's doing. */
  async removeContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

const STACK_IMAGES = ["server", "runner", "credproxy"];
/** Where the stack's images come from: local builds, and releases. */
const BUILT_PREFIX = "nibblet/";
const IMAGE_PREFIXES = [BUILT_PREFIX, "ghcr.io/infrawrench/nibblets-"];

/**
 * The images this release runs, worked out from the runner's, which the
 * others share a prefix and tag with. Null for a runner image named some
 * other way, where there's no telling which of ours are old.
 */
export function currentImages(runnerImage: string): Set<string> | null {
  const m = /^(.*)runner:([^:/]+)$/.exec(runnerImage);
  if (!m) return null;
  const [, prefix, tag] = m;
  return new Set([...STACK_IMAGES.map((name) => `${prefix}${name}:${tag}`), TUNNEL_IMAGE]);
}

/**
 * What to remove: tags of our images other than the current ones, and
 * untagged builds of ours. Pulled images only when made before the current
 * runner image (`since`, in seconds), so a newer release being pulled for an
 * update in the meantime is left alone. Local builds whatever their age: a
 * checkout that built its images before switching to a release's has builds
 * newer than the release, and nothing pulls them.
 */
export function staleImages(
  images: Pick<Docker.ImageInfo, "Id" | "RepoTags" | "Labels" | "Created">[],
  current: Set<string>,
  since: number,
): string[] {
  const ours = (ref: string) => {
    const repo = ref.slice(0, ref.lastIndexOf(":"));
    return (
      repo === TUNNEL_IMAGE.slice(0, TUNNEL_IMAGE.lastIndexOf(":")) ||
      IMAGE_PREFIXES.some((p) => STACK_IMAGES.some((name) => repo === `${p}${name}`))
    );
  };
  const out: string[] = [];
  for (const image of images) {
    const tags = (image.RepoTags ?? []).filter((t) => t !== "<none>:<none>");
    if (tags.length === 0) {
      if (image.Labels?.["nibblet.image"]) out.push(image.Id);
      continue;
    }
    const recent = image.Created >= since;
    out.push(
      ...tags.filter((t) => ours(t) && !current.has(t) && (!recent || t.startsWith(BUILT_PREFIX))),
    );
  }
  return out;
}
