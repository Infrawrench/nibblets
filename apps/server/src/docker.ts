import { Readable, Writable } from "node:stream";
import Docker from "dockerode";
import {
  CONTAINER_SSH_AUTH_SOCK,
  CONTAINER_TAILSCALE_STATE,
  DEFAULT_MEMORY_MB,
  defaultResources,
  HARNESS_CLI_DIR,
  HARNESS_CLI_VOLUME,
  type Resources,
  type GuardEnv,
  type RunnerEnv,
} from "@nibblet/protocol";
import type { Config } from "./config.ts";
import { TUNNEL_IMAGE } from "./tunnel.ts";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";
const NIBBLET = "nibblet.id";

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

/** Caches inside a home folder that rebuild themselves, so aren't worth snapshotting. */
const HOME_ARCHIVE_EXCLUDES = [
  "nibblet/.cache",
  "nibblet/.npm/_cacache",
  // The browser's profile, in the guard's home (and where it was before the guard).
  ...["nibblet/.guard/.config/chromium", "nibblet/.config/chromium"].flatMap((profile) => [
    `${profile}/*/Cache`,
    `${profile}/*/Code Cache`,
    `${profile}/*/GPUCache`,
    `${profile}/*/Service Worker/CacheStorage`,
  ]),
];

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
const borrowProxyName = (nibbletId: string): string => `nibblet-borrow-proxy-${nibbletId}`;
/** The port the borrow proxy listens on inside its container; the host port is chosen by Docker. */
const BORROW_PROXY_PORT = 8888;
/**
 * A tiny forward proxy for a borrowed window: plain HTTP requests are
 * forwarded, HTTPS is tunnelled with CONNECT. It only ever listens on the
 * nibblet's network and is reached from the host's loopback through Docker's
 * published port, so it takes no authentication of its own.
 */
const BORROW_PROXY_SCRIPT = `
const http = require("http");
const net = require("net");
const { URL } = require("url");
const port = Number(process.env.PORT || 8888);
const server = http.createServer((req, res) => {
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  const up = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
    },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
  );
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
server.on("connect", (req, client, head) => {
  const i = req.url.lastIndexOf(":");
  const host = req.url.slice(0, i);
  const p = Number(req.url.slice(i + 1)) || 443;
  const up = net.connect(p, host, () => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
});
server.listen(port, "0.0.0.0");
`;
/** Where a sub-agent's entry leaves its pid in its host's container (SUBAGENT_PIDS in the runner). */
const SUBAGENT_PIDS = "/run/nibblet-subagents";

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
    env: RunnerEnv & GuardEnv,
    opts: { sshAgent: boolean; resources: Resources; tailscale?: boolean } = {
      sshAgent: false,
      resources: defaultResources,
    },
  ): Promise<string> {
    const home = await this.ensureHome(nibbletId);
    // Mounted while it's on the tailnet, and after, so its entry can sign the machine out.
    const tailscale = opts.tailscale
      ? await this.ensureVolume(tailscaleVolume(nibbletId), "tailscale", nibbletId)
      : (await this.volumeExists(tailscaleVolume(nibbletId)))
        ? tailscaleVolume(nibbletId)
        : null;
    await this.carryOverHome(nibbletId, home);
    await this.removeContainer(runnerName(nibbletId), { graceful: true });
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

  /** Whether a nibblet's own container is up. */
  async runnerRunning(nibbletId: string): Promise<boolean> {
    try {
      return (await this.docker.getContainer(runnerName(nibbletId)).inspect()).State.Running;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * Starts a sub-agent in the container of the nibblet it works for (`hostId`):
   * its own guard and runner beside the host's, sharing its files, tools and
   * servers (see the runner's entry). `onExit` is called with the end of its
   * output when they stop, whether on their own or with the container.
   */
  async startSubagent(
    hostId: string,
    nibbletId: string,
    env: RunnerEnv & GuardEnv,
    onExit: (code: number | null, tail: string) => void,
  ): Promise<void> {
    const container = this.docker.getContainer(runnerName(hostId));
    const exec = await container.exec({
      Cmd: ["node", "/app/apps/runner/src/entry.ts", "subagent"],
      // Root, as the container's own entry: it splits into the guard and the agent.
      User: "0",
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
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
    await this.inRunner(
      hostId,
      [
        "sh",
        "-c",
        // The id comes in the environment, not the script.
        `f="${SUBAGENT_PIDS}/$SUBAGENT.pid"; pid=$(cat "$f" 2>/dev/null) || exit 0
kill -TERM "$pid" 2>/dev/null || exit 0
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt ${RUNNER_STOP_SECONDS * 4} ]; do sleep 0.25; i=$((i+1)); done
kill -KILL "$pid" 2>/dev/null; true`,
      ],
      { SUBAGENT: nibbletId },
    );
  }

  /**
   * Deletes what a sub-agent kept in its host's home: its harness's state and
   * its browser profile, with its logins. In the host's container when it's
   * up, or straight from its home volume when it isn't.
   */
  async removeSubagentState(hostId: string, nibbletId: string): Promise<void> {
    // It goes into a path, and a stopped host's helper takes no environment.
    if (!/^[\w-]+$/.test(nibbletId)) throw new Error(`not a nibblet id: ${nibbletId}`);
    const cmd = [
      "rm",
      "-rf",
      `${RUNNER_HOME}/.subagents/${nibbletId}`,
      `${RUNNER_HOME}/.guard/subagents/${nibbletId}`,
    ];
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
    if (!(await this.runnerRunning(nibbletId))) return false;
    const exec = await this.docker.getContainer(runnerName(nibbletId)).exec({
      Cmd: cmd,
      User: "0",
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
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
  private ensureHome(nibbletId: string): Promise<string> {
    return this.ensureVolume(homeVolume(nibbletId), "home", nibbletId);
  }

  private async ensureVolume(name: string, role: string, nibbletId: string): Promise<string> {
    if (await this.volumeExists(name)) return name;
    await this.docker.createVolume({
      Name: name,
      Labels: { [MANAGED]: "true", [ROLE]: role, [NIBBLET]: nibbletId },
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

  /**
   * Writes just the browser profile (the guard's `~/.config/chromium`), as a
   * gzipped tar rooted at `chromium/`, to `out`. The nibblet must be stopped
   * first (a borrow stops it), so nothing is browsing while it's copied; the
   * caches that rebuild themselves are left out. An empty profile is made if
   * the nibblet never browsed, so the window still opens.
   */
  async archiveProfile(nibbletId: string, out: Writable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    const excludes = PROFILE_ARCHIVE_EXCLUDES.map((e) => `--exclude=${e}`).join(" ");
    await this.inHome(
      volume,
      [
        "sh",
        "-c",
        `cd ${PROFILE_PARENT} && mkdir -p chromium && tar --numeric-owner ${excludes} -czf - chromium`,
      ],
      { readOnly: false, stdout: out },
    );
  }

  /**
   * Replaces the browser profile from a tar made by `archiveProfile` (rooted
   * at `chromium/`), handing ownership back to the guard. The nibblet must be
   * stopped; its guard clears any stale profile lock when it starts again.
   */
  async restoreProfile(nibbletId: string, archive: Readable): Promise<void> {
    const volume = await this.ensureHome(nibbletId);
    await this.inHome(
      volume,
      [
        "sh",
        "-c",
        `mkdir -p ${PROFILE_PARENT} && rm -rf ${PROFILE_PARENT}/chromium && ` +
          `tar -C ${PROFILE_PARENT} --no-same-owner -xzf - && ` +
          `chown -R ${GUARD_OWNER} ${PROFILE_PARENT}/chromium`,
      ],
      { readOnly: false, stdin: archive },
    );
  }

  /**
   * The user-agent the nibblet's Chromium presents, worked out from the
   * runner image's Chromium version, so a borrowed window on the host can
   * look like the nibblet. Null if the version can't be read.
   */
  async browserUserAgent(): Promise<string | null> {
    const stdout: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        stdout.push(chunk);
        done();
      },
    });
    try {
      await this.runImageCapture(["/usr/bin/chromium", "--version"], sink);
    } catch {
      return null;
    }
    const major = /\b(\d+)\.\d+\.\d+/.exec(Buffer.concat(stdout).toString("utf8"))?.[1];
    if (!major) return null;
    return (
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${major}.0.0.0 Safari/537.36`
    );
  }

  /**
   * An HTTP/HTTPS proxy on the nibblet's own Docker network, published on the
   * host's loopback, so a borrowed window egresses from the same place the
   * nibblet would (its public IP). It runs while the nibblet is stopped for a
   * borrow; a Tailscale exit node isn't reproduced, since that lived in the
   * stopped container. Returns the host port and how to stop it.
   */
  async startBorrowProxy(nibbletId: string): Promise<{ port: number; stop: () => Promise<void> }> {
    const name = borrowProxyName(nibbletId);
    await this.removeContainer(name);
    const container = await this.docker.createContainer({
      name,
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Cmd: ["node", "-e", BORROW_PROXY_SCRIPT],
      Env: [`PORT=${BORROW_PROXY_PORT}`],
      Labels: { [MANAGED]: "true", [ROLE]: "borrow-proxy", [NIBBLET]: nibbletId },
      ExposedPorts: { [`${BORROW_PROXY_PORT}/tcp`]: {} },
      HostConfig: {
        NetworkMode: this.config.NIBBLET_NETWORK,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 128,
        RestartPolicy: { Name: "no" },
        // The host (where the borrowed window runs) reaches it on loopback only.
        PortBindings: { [`${BORROW_PROXY_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
      },
    });
    const stop = () => this.removeContainer(name);
    try {
      await container.start();
      const info = await container.inspect();
      const bound = info.NetworkSettings.Ports?.[`${BORROW_PROXY_PORT}/tcp`]?.[0]?.HostPort;
      const port = bound ? Number(bound) : NaN;
      if (!Number.isInteger(port)) throw new Error("the proxy didn't get a host port");
      return { port, stop };
    } catch (err) {
      await stop().catch(() => undefined);
      throw err;
    }
  }

  /** Runs a command in a throwaway runner container, offline, capturing stdout. */
  private async runImageCapture(cmd: string[], stdout: Writable): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      User: "0",
      Cmd: cmd,
      Labels: { [MANAGED]: "true", [ROLE]: "probe" },
      HostConfig: { NetworkMode: "none", ...RUNNER_HARDENING },
    });
    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      this.docker.modem.demuxStream(
        stream,
        stdout,
        new Writable({
          write(_c, _e, done) {
            done();
          },
        }),
      );
      await container.start();
      const result: { StatusCode: number } = await container.wait();
      if (result.StatusCode !== 0) throw new Error(`${cmd[0]} exited ${result.StatusCode}`);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
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
      Image: this.config.NIBBLET_RUNNER_IMAGE,
      Cmd: ["node", "/app/apps/runner/src/entry.ts", "tailscale-leave"],
      Labels: { [MANAGED]: "true", [ROLE]: "tailscale-leave", [NIBBLET]: nibbletId },
      HostConfig: {
        NetworkMode: this.config.NIBBLET_NETWORK,
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

  async stopRunner(nibbletId: string): Promise<void> {
    await this.carryOverHome(nibbletId, await this.ensureHome(nibbletId));
    await this.removeContainer(runnerName(nibbletId), { graceful: true });
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

/** What `docker stop` gives a runner: past the entry's own 10-second wait. */
const RUNNER_STOP_SECONDS = 12;

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
