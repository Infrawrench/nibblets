import { Writable } from "node:stream";
import Docker from "dockerode";
import { DockerMachines, isNotFound } from "@nibblets/machine-docker";
import { HARNESS_CLI_DIR, HARNESS_CLI_VOLUME } from "@nibblets/protocol";
import type { Config } from "./config.ts";
import { TUNNEL_IMAGE } from "./tunnel.ts";

const MANAGED = "nibblet.managed";
const ROLE = "nibblet.role";
const NIBBLET = "nibblet.id";

const borrowProxyName = (nibbletId: string): string => `nibblet-borrow-proxy-${nibbletId}`;
/** The port the borrow proxy listens on inside its container; the host port is chosen by Docker. */
const BORROW_PROXY_PORT = 8888;
/**
 * A tiny forward proxy for a borrowed window: plain HTTP requests are
 * forwarded, HTTPS is tunnelled with CONNECT. It's reached from the host's
 * loopback through a published port, so anything on that computer can use
 * it; like a runner's firewall (firewallRules in the runner's entry), it
 * refuses its own network (other nibblets, the server) and link-local
 * addresses (cloud metadata), checking each address a name resolves to, so
 * it reaches nothing a program on the host couldn't already.
 */
const BORROW_PROXY_SCRIPT = `
const http = require("http");
const net = require("net");
const dns = require("dns");
const os = require("os");
const { URL } = require("url");
const port = Number(process.env.PORT || 8888);
const deny = new net.BlockList();
deny.addSubnet("0.0.0.0", 8);
deny.addSubnet("127.0.0.0", 8);
deny.addSubnet("169.254.0.0", 16);
deny.addAddress("::", "ipv6");
deny.addAddress("::1", "ipv6");
deny.addSubnet("fe80::", 10, "ipv6");
for (const i of Object.values(os.networkInterfaces()).flat()) {
  if (!i || i.internal || !i.cidr) continue;
  const [ip, bits] = i.cidr.split("/");
  deny.addSubnet(ip, Number(bits), i.family === "IPv6" ? "ipv6" : "ipv4");
}
const bare = (host) => host.replace(/^\\[|\\]$/g, "");
const blocked = (ip) => deny.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");
const refused = () => Object.assign(new Error("blocked"), { code: "EBLOCKED" });
// Every address a name resolves to is checked, and only allowed ones are dialled.
function lookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, found) => {
    if (err) return cb(err);
    const ok = found.filter((a) => !blocked(a.address));
    if (!ok.length) return cb(refused());
    if (options.all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}
const server = http.createServer((req, res) => {
  let target;
  try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  const host = bare(target.hostname);
  if (net.isIP(host) && blocked(host)) { res.writeHead(403).end(); return; }
  const up = http.request(
    {
      host,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
      lookup,
    },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
  );
  up.on("error", (err) => {
    if (!res.headersSent) res.writeHead(err.code === "EBLOCKED" ? 403 : 502);
    res.end();
  });
  req.pipe(up);
});
server.on("connect", (req, client, head) => {
  const i = req.url.lastIndexOf(":");
  const host = bare(req.url.slice(0, i));
  const p = Number(req.url.slice(i + 1)) || 443;
  if (net.isIP(host) && blocked(host)) {
    client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
    return;
  }
  const up = net.connect({ port: p, host, lookup }, () => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head && head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on("error", (err) => {
    if (err.code === "EBLOCKED") client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
    else client.destroy();
  });
  client.on("error", () => up.destroy());
});
server.listen(port, "0.0.0.0");
`;

/**
 * The server's handle on the stack's Docker engine, for what isn't a
 * nibblet's machine (those are `DockerMachines`, a machine plugin): the
 * runners' network, throwaway runner containers for short jobs, the
 * cloudflared container for tunnels, the proxy for a borrowed browser, and
 * tidying up old images.
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
      stack: this.config.NIBBLET_STACK,
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

  /**
   * The user-agent the nibblet's Chromium presents, worked out from the
   * runner image's Chromium version, so a borrowed window on the host can
   * look like the nibblet. Null if the version can't be read.
   */
  async browserUserAgent(): Promise<string | null> {
    const result = await this.runOnce(["/usr/bin/chromium", "--version"], "", 30_000).catch(
      () => null,
    );
    if (result?.code !== 0) return null;
    const major = /\b(\d+)\.\d+\.\d+/.exec(result.stdout)?.[1];
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

  /** Removes borrow proxies a previous server left running (it stopped mid-borrow). */
  async removeBorrowProxies(): Promise<void> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED}=true`, `${ROLE}=borrow-proxy`] },
    });
    for (const c of list) {
      await this.docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => undefined);
    }
  }

  /** Removes a container of the stack's (the tunnel's, a borrow proxy), if it's there, whatever it's doing. */
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
