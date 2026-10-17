import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HypervisorClient, VirtualMachines } from "@nibblet/machine";
import { HostMachines, type HypervisorPlugin } from "@nibblet/machine/host";
import { GuestDaemon } from "../src/machine/daemon.ts";
import type { GuestPlugin } from "../src/machine/guest.ts";

/**
 * Everything between the server and a guest's entry, with no VM: the
 * server's VM plugin, the bridge's API and relay, a hypervisor whose
 * "machine" is a unix socket with the guest daemon on the far end, and an
 * entry that's a script.
 */

const ENTRY = `
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.log("nibblet up as " + process.env.NIBBLET_ID);
  if (process.env.CRASH) setTimeout(() => process.exit(3), 100);
  process.on("SIGTERM", () => { console.log("stopping"); process.exit(0); });
  setInterval(() => {}, 1000);
} else if (command === "archive-home") {
  process.stdout.write(Buffer.alloc(300_000, 7));
} else if (command === "restore-home") {
  let n = 0;
  process.stdin.on("data", (d) => (n += d.length));
  process.stdin.on("end", () => { if (n !== 200_000) process.exit(9); });
} else if (command === "stop-subagent") {
  console.log("stopped " + args[0]);
} else if (command === "subagent") {
  console.log("sub-agent " + process.env.NIBBLET_ID);
  setTimeout(() => process.exit(0), 200);
} else process.exit(2);
`;

describe("a nibblet in a virtual machine, without the machine", () => {
  let dir: string;
  /** Unix sockets' paths are short on macOS: these get a folder of their own. */
  let sockets: string;
  let entry: string;
  /** The "guest's loopback": a port the server opens through the link. */
  let echo: Server;
  /** The host's server, which the guest's connections reach through the relay. */
  let host: HttpServer;
  let bridge: HttpServer;
  let machines: HostMachines;
  let vms: VirtualMachines;
  const guests = new Map<
    string,
    { server: Server; socket: Socket | null; daemon: GuestDaemon; ports: Record<string, number> }
  >();
  const exits: { id: string; code: number | null }[] = [];

  const listen = (server: Server | HttpServer) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nibblet-machine-"));
    sockets = await mkdtemp(join(tmpdir(), "nb-"));
    entry = join(dir, "entry.mjs");
    await writeFile(entry, ENTRY);
    echo = createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    host = createHttp((_req, res) => res.end("hello from the host"));
    const hostPort = await listen(host);

    const guestPlugin = (stop: () => void): GuestPlugin => ({
      os: "linux",
      prepare: async () => {},
      openPort: async () => {
        throw new Error("unused");
      },
      entry: (command, args) => ({
        file: process.execPath,
        argv: [entry, ...(command === "main" ? [] : [command, ...args])],
      }),
      poweroff: async () => stop(),
    });

    const fake: HypervisorPlugin = {
      id: "fake",
      name: "Fake",
      diskFormat: "raw",
      detect: async () => ({ available: true, detail: null, guests: ["linux"] }),
      imageSource: () => "none",
      prepareImage: async () => {},
      start: async (_ctx, vm) => {
        const path = join(sockets, `${vm.id}.sock`);
        await mkdir(vm.dir, { recursive: true });
        await rm(path, { force: true });
        const guest = {
          server: createServer(),
          socket: null as Socket | null,
          daemon: new GuestDaemon({
            guest: guestPlugin(() => {
              guest.socket?.destroy();
              guest.server.close();
              guests.delete(vm.id);
            }),
            version: "test",
            listen: {
              server: { host: "127.0.0.1", port: 0 },
              credproxy: { host: "127.0.0.1", port: 0 },
            },
            log: () => {},
          }),
          ports: {},
        };
        guest.ports = await guest.daemon.listen();
        guest.server.on("connection", (socket) => {
          guest.socket = socket;
          guest.daemon.attach(socket);
        });
        await new Promise<void>((resolve) => guest.server.listen(path, resolve));
        guests.set(vm.id, guest);
      },
      stop: async (_ctx, vm) => {
        const guest = guests.get(vm.id);
        guest?.socket?.destroy();
        guest?.server.close();
        guest?.daemon.close();
        guests.delete(vm.id);
      },
      running: async (_ctx, vm) => guests.has(vm.id),
      remove: async () => {},
      connect: (_ctx, vm) =>
        new Promise((resolve, reject) => {
          const socket = connect(join(sockets, `${vm.id}.sock`));
          socket.once("connect", () => resolve(socket));
          socket.once("error", reject);
        }),
      console: async () => "",
      capacity: async () => ({ cpus: 4, memoryMb: 8192 }),
    };

    machines = new HostMachines({
      plugins: [fake],
      dir: join(dir, "machines"),
      docker: null,
      targets: {
        server: { host: "127.0.0.1", port: hostPort },
        credproxy: { host: "127.0.0.1", port: hostPort },
      },
    });
    // An image, as though it had been made.
    const image = join(dir, "machines", "fake", "images", "linux");
    await mkdir(join(image, "v1"), { recursive: true });
    await writeFile(
      join(image, "current.json"),
      JSON.stringify({ dir: join(image, "v1"), builtFrom: "img1" }),
    );
    bridge = createHttp((req, res) => {
      void machines.handle(req, res, new URL(req.url ?? "/", "http://b").pathname);
    });
    bridge.on("upgrade", (req, socket, head) => {
      machines.upgrade(req, socket, head, new URL(req.url ?? "/", "http://b").pathname);
    });
    const bridgePort = await listen(bridge);

    vms = new VirtualMachines({
      meta: { id: "fake", name: "Fake" },
      client: new HypervisorClient({ url: `http://127.0.0.1:${bridgePort}`, token: "t" }, "fake"),
      runnerImage: async () => ({ name: "runner", id: "img1" }),
      version: "test",
      log: () => {},
    });
    await vms.watchExits((id, code) => exits.push({ id, code }));
    void echoPort;
  });

  afterAll(async () => {
    machines.close();
    for (const s of [echo, host, bridge]) s.close();
    await rm(dir, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  });

  const spec = (env: Record<string, string>) => ({
    machine: { backend: "fake", guest: "linux" as const },
    env,
    resources: { cpus: null, memoryMb: null },
    sshAgent: false,
    tailscale: false,
    progress: () => {},
  });

  it("starts the nibblet's entry in its machine, and says it's running", async () => {
    const id = await vms.start("nib_a", spec({ NIBBLET_ID: "nib_a" }));
    expect(id).toMatch(/^vm:/);
    expect(await vms.running("nib_a")).toBe(true);
    expect((await vms.machines()).get("nib_a")?.running).toBe(true);
    await expect.poll(() => vms.logs("nib_a", 5)).toContain("nibblet up as nib_a");
  });

  it("reaches a port inside it", async () => {
    const echoPort = (() => {
      const a = echo.address();
      return typeof a === "object" && a ? a.port : 0;
    })();
    const address = await vms.address("nib_a", echoPort);
    expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
    const [h, p] = (address ?? "").split(":");
    const socket = connect({ host: h, port: Number(p) });
    const said = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString()));
      socket.write("ping through the port");
    });
    socket.destroy();
    expect(said).toBe("ping through the port");
  });

  it("lets the guest reach the host's server through the relay", async () => {
    const guest = guests.get("nib_a");
    const res = await fetch(`http://127.0.0.1:${guest?.ports.server}/`);
    expect(await res.text()).toBe("hello from the host");
  });

  it("archives and restores a home folder through the link", async () => {
    let got = 0;
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        got += chunk.length;
        done();
      },
    });
    await vms.archiveHome("nib_a", out);
    expect(got).toBe(300_000);
    const { Readable } = await import("node:stream");
    await vms.restoreHome("nib_a", Readable.from([Buffer.alloc(100_000), Buffer.alloc(100_000)]));
  });

  it("runs a sub-agent beside it and hears when it ends", async () => {
    const ended = new Promise<{ code: number | null; tail: string }>((resolve) =>
      vms.startSubagent("nib_a", "nib_b", { NIBBLET_ID: "nib_b" }, (code, tail) =>
        resolve({ code, tail }),
      ),
    );
    const { code, tail } = await ended;
    expect(code).toBe(0);
    expect(tail).toContain("sub-agent nib_b");
    await vms.stopSubagent("nib_a", "nib_b");
  });

  it("stops it without calling that an exit", async () => {
    await vms.stop("nib_a");
    expect(await vms.running("nib_a")).toBe(false);
    expect(exits).toEqual([]);
  });

  it("says when its entry stops on its own", async () => {
    await vms.start("nib_c", spec({ NIBBLET_ID: "nib_c", CRASH: "1" }));
    await expect.poll(() => exits, { timeout: 5000 }).toEqual([{ id: "nib_c", code: 3 }]);
    await vms.discard("nib_c");
  });
});
