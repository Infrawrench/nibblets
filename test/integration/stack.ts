import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { contract, createClient, fetchTransport, type Client } from "@nibblet/protocol";
import { hostMachines, startHostMcpBridge, type HostMcpBridge } from "@nibblet/host-mcp";
import { z } from "zod";

/**
 * A whole Nibblets stack for a test, beside whatever else is on the engine:
 * its own compose project, networks, ports and stack label (so its server
 * only tidies up its own nibblets), the server and runner images under
 * test, and a fake Anthropic API (fake-anthropic.ts) where the credential
 * proxy would be, so nibblets run the real Claude Code harness with no
 * credentials. For VM backends, a host bridge in this process, with the
 * host's hypervisor, as the desktop app or install.sh would run.
 */

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));

export interface StackOptions {
  serverImage: string;
  runnerImage: string;
  /** Run a host bridge with this OS's hypervisor, for VM backends. */
  bridge: boolean;
  /** The engine's socket, as the engine sees it, for the server to mount. */
  dockerSocket: string;
  /** Where the bridge keeps VMs and images, kept afterwards; a folder of the stack's own if not given. */
  machinesDir?: string;
  /**
   * The engine is in WSL, which sees this computer's drives as /mnt/<letter>:
   * folders it mounts are given that way. For Hyper-V without Docker Desktop.
   */
  dockerInWsl?: boolean;
  /**
   * Where containers reach this computer, where `host-gateway` isn't it (an
   * engine in WSL): the bridge then listens on every address, at that one.
   */
  hostFromDocker?: string;
  /** The Hyper-V switch VMs go out through, where there's no Default Switch. */
  hypervSwitch?: string;
  log?: (line: string) => void;
}

/** A folder of this computer's, as an engine in WSL sees it: D:\a\b is /mnt/d/a/b. */
export function wslPath(path: string): string {
  return path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, "/");
}

const secret = () => randomBytes(24).toString("hex");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Where containers reach the host: Docker Desktop's host.docker.internal is loopback, Linux's the bridge. */
async function bridgeHost(): Promise<string> {
  if (process.platform !== "linux") return "127.0.0.1";
  const { stdout } = await run("docker", [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  return stdout.trim() || "172.17.0.1";
}

export class TestStack {
  readonly project = `nibblet-it-${randomBytes(3).toString("hex")}`;
  readonly ownerToken = secret();
  client!: Client<typeof contract>;
  port = 0;
  fakePort = 0;
  private dir = "";
  private bridge: HostMcpBridge | null = null;
  private bridgeAddress = { url: "", token: "" };
  private readonly opts: StackOptions;
  private readonly log: (line: string) => void;

  constructor(opts: StackOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private compose(args: string[], timeoutMs = 15 * 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["compose", "-p", this.project, "-f", join(this.dir, "compose.json"), ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      const lines = (chunk: Buffer) => {
        out += chunk.toString();
        for (const line of chunk.toString().split("\n")) if (line.trim()) this.log(line);
      };
      child.stdout.on("data", lines);
      child.stderr.on("data", lines);
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`docker compose ${args[0]} exited ${code}: ${out.slice(-2000)}`));
      });
    });
  }

  /**
   * Brings it up. Windows and macOS guests install the runner from GitHub:
   * `guestRef` is the commit of `repo` they're to install.
   */
  async up(guests: { guestRef?: string; repo?: string } = {}): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), `${this.project}-`));
    this.port = await freePort();
    this.fakePort = await freePort();
    const credproxyKey = secret();
    let hostMcp = { url: "", token: "" };
    if (this.opts.bridge) {
      const token = secret();
      const fromDocker = this.opts.hostFromDocker;
      const host = fromDocker ? "0.0.0.0" : await bridgeHost();
      this.bridge = await startHostMcpBridge({
        port: 0,
        host,
        token,
        // Nothing of the host's own: no MCP servers, no CLIs.
        configPaths: [],
        clis: [],
        machines: await hostMachines({
          dir: this.opts.machinesDir ?? join(this.dir, "machines"),
          server: this.base,
          credproxy: `http://127.0.0.1:${this.fakePort}`,
          ...(process.env.NIBBLET_TEST_APPLE_HELPER
            ? { appleHelper: process.env.NIBBLET_TEST_APPLE_HELPER }
            : {}),
          ...(this.opts.hypervSwitch ? { hypervSwitch: this.opts.hypervSwitch } : {}),
          log: (m) => this.log(`bridge: ${m}`),
        }),
        log: (m) => this.log(`bridge: ${m}`),
      });
      hostMcp = {
        url: `http://${fromDocker ?? "host.docker.internal"}:${this.bridge.port}`,
        token,
      };
      this.bridgeAddress = {
        url: `http://${fromDocker ? "127.0.0.1" : host}:${this.bridge.port}`,
        token,
      };
    }
    const runners = `${this.project}-runners`;
    const definition = {
      name: this.project,
      services: {
        db: {
          image: "docker.io/pgvector/pgvector:0.8.7-pg18",
          environment: {
            POSTGRES_USER: "nibblet",
            POSTGRES_DB: "nibblet",
            POSTGRES_PASSWORD: "nibblet",
          },
          healthcheck: {
            test: ["CMD-SHELL", "pg_isready -U nibblet -d nibblet"],
            interval: "2s",
            timeout: "5s",
            retries: 30,
          },
          networks: ["main"],
        },
        // The fake, by the credential proxy's name, where runners look for it.
        credproxy: {
          image: "docker.io/library/node:24-trixie-slim",
          command: ["node", "/fake/fake-anthropic.ts", "8787"],
          volumes: [`${this.opts.dockerInWsl ? wslPath(here) : here}:/fake:ro`],
          ports: [`127.0.0.1:${this.fakePort}:8787`],
          networks: ["main", "runners"],
        },
        server: {
          image: this.opts.serverImage,
          pull_policy: "never",
          depends_on: {
            db: { condition: "service_healthy" },
            credproxy: { condition: "service_started" },
          },
          environment: {
            PORT: "8420",
            DATABASE_URL: "postgres://nibblet:nibblet@db:5432/nibblet",
            NIBBLET_OWNER_TOKEN: this.ownerToken,
            CREDPROXY_URL: "http://credproxy:8787",
            CREDPROXY_KEY: credproxyKey,
            CREDPROXY_ADMIN_KEY: secret(),
            NIBBLET_RUNNER_IMAGE: this.opts.runnerImage,
            NIBBLET_NETWORK: runners,
            NIBBLET_STACK: this.project,
            NIBBLET_PRUNE_IMAGES: "0",
            NIBBLET_HARNESS_UPDATES: "0",
            NIBBLET_GUEST_REF: guests.guestRef ?? "",
            ...(guests.repo ? { NIBBLET_UPDATE_REPO: guests.repo } : {}),
            HOST_MCP_URL: hostMcp.url,
            HOST_MCP_TOKEN: hostMcp.token,
            NIBBLET_HOST_PLATFORM:
              process.platform === "win32"
                ? "win32"
                : process.platform === "darwin"
                  ? "darwin"
                  : "linux",
          },
          // Only with a bridge to reach: older Podman doesn't know host-gateway.
          ...(this.opts.bridge && !this.opts.hostFromDocker
            ? { extra_hosts: ["host.docker.internal:host-gateway"] }
            : {}),
          ports: [`127.0.0.1:${this.port}:8420`],
          volumes: [`${this.opts.dockerSocket}:/var/run/docker.sock`],
          networks: ["main", "runners"],
        },
      },
      networks: { main: { name: this.project }, runners: { name: runners } },
    };
    // JSON is YAML, so compose takes it as it is.
    await writeFile(join(this.dir, "compose.json"), JSON.stringify(definition, null, 2));
    await this.compose(["up", "-d"]);
    const until = Date.now() + 180_000;
    for (;;) {
      const ok = await fetch(`${this.base}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (Date.now() > until) {
        throw new Error(`The test server never came up:\n${await this.logs()}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.client = createClient(
      contract,
      fetchTransport(`${this.base}/api/rpc`, () => ({
        authorization: `Bearer ${this.ownerToken}`,
      })),
    );
  }

  /** The server's own output, for saying why something didn't work. */
  async logs(): Promise<string> {
    return this.compose(["logs", "--no-color", "--tail", "200", "server"]).catch((err: unknown) =>
      String(err),
    );
  }

  /** The calls the fake model has had: what each offered, and what it answered. */
  async modelCalls(): Promise<{ tools: string[]; last: string; answer: string }[]> {
    const res = await fetch(`http://127.0.0.1:${this.fakePort}/requests`);
    const call = z.object({ tools: z.array(z.string()), last: z.string(), answer: z.string() });
    return z.object({ calls: z.array(call) }).parse(await res.json()).calls;
  }

  /** The VMs a hypervisor has on the host, by nibblet, as the bridge says. */
  async vms(hypervisor: string): Promise<string[]> {
    const res = await fetch(`${this.bridgeAddress.url}/machines/${hypervisor}/vms`, {
      headers: { authorization: `Bearer ${this.bridgeAddress.token}` },
    });
    if (!res.ok) throw new Error(`The bridge's VMs answered ${res.status}`);
    return z
      .array(z.object({ id: z.string() }))
      .parse(await res.json())
      .map((v) => v.id);
  }

  /** Its nibblets' containers, by the labels this stack's server gives them. */
  async containers(): Promise<string[]> {
    const { stdout } = await run("docker", [
      "ps",
      "-a",
      "--filter",
      `label=nibblet.stack=${this.project}`,
      "--format",
      "{{.Names}}",
    ]);
    return stdout.split("\n").filter(Boolean);
  }

  /**
   * Everything it made, gone: its nibblets through the API (their machines
   * and homes with them), then the stack, then anything of its stack's
   * that's left over.
   */
  async down(): Promise<void> {
    if (this.client) {
      const all = await this.client.nibblets.list({}).catch(() => []);
      for (const n of all.filter((x) => !x.parentId)) {
        await this.client.nibblets.delete({ id: n.id }).catch(() => undefined);
      }
    }
    await this.compose(["down", "-v", "--remove-orphans"]).catch(() => undefined);
    for (const kind of ["container", "volume"]) {
      const { stdout } = await run("docker", [
        kind,
        "ls",
        ...(kind === "container" ? ["-a"] : []),
        "-q",
        "--filter",
        `label=nibblet.stack=${this.project}`,
      ]).catch(() => ({ stdout: "" }));
      const ids = stdout.split("\n").filter(Boolean);
      if (ids.length) await run("docker", [kind, "rm", "-f", ...ids]).catch(() => undefined);
    }
    await this.bridge?.close();
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
