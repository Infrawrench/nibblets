import { execFile } from "node:child_process";
import { mkdir, open, readdir, readFile, stat, writeFile, type FileHandle } from "node:fs/promises";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import {
  APPLE_AGENT_VSOCK_PORT,
  GUEST_PORT_NAME,
  HYPERV_AGENT_PORT,
  TAILSCALE_GID,
  TAILSCALE_UID,
} from "@nibblets/protocol";
import { entryArgv, relayStream, type GuestPlugin } from "./guest.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The home disk: everything the nibblet keeps, as a container's volumes are. */
const DATA = "/var/lib/nibblet-data";
const HOME = "/home/nibblet";
const TAILSCALE_STATE = "/var/lib/nibblet-tailscale";
const HOME_LABEL = "nibblet-home";
const ENTRY = new URL("../entry.ts", import.meta.url).pathname;
/** The relay for Hyper-V's socket, which Node can't open itself. */
const HVSOCK_RELAY = new URL("./hvsock-relay.py", import.meta.url).pathname;

/**
 * Where its port shows up: a named virtio serial port (KVM), the second
 * virtio console (Apple's, after the console's hvc0), or a serial port. On
 * Hyper-V it's a Hyper-V socket instead (openPort).
 */
const PORTS = [`/dev/virtio-ports/${GUEST_PORT_NAME}`, "/dev/hvc1", "/dev/ttyS1"];

async function sh(cmd: string, args: string[]): Promise<string> {
  return (await run(cmd, args, { timeout: 120_000 })).stdout;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The disk the root is on, and which partition. */
async function rootDisk(): Promise<{ disk: string; partition: string; device: string }> {
  const device = (await sh("findmnt", ["-no", "SOURCE", "/"])).trim();
  const name = device.replace(/^\/dev\//, "");
  const parent = (await sh("lsblk", ["-no", "PKNAME", device])).trim();
  const partition = (await readFile(`/sys/class/block/${name}/partition`, "utf8")).trim();
  return { disk: `/dev/${parent}`, partition, device };
}

/** Grows the root partition and its filesystem to fill a disk that's been made bigger. */
async function growRoot(log: (m: string) => void): Promise<void> {
  const { disk, partition, device } = await rootDisk();
  // growpart says NOCHANGE, and exits 1, when there's nothing to grow.
  const grown = await run("growpart", [disk, partition], { timeout: 120_000 }).then(
    () => true,
    (err: NodeJS.ErrnoException & { stdout?: string }) => {
      if (!err.stdout?.includes("NOCHANGE")) log(`couldn't grow the root: ${err.message}`);
      return false;
    },
  );
  if (!grown) return;
  await sh("resize2fs", [device]);
  log(`grew ${device} to fill ${disk}`);
}

/** The home disk: the one labelled for it, or the first blank one, made into it. */
async function homeDisk(log: (m: string) => void): Promise<string> {
  const labelled = await sh("blkid", ["-L", HOME_LABEL]).catch(() => "");
  if (labelled.trim()) return labelled.trim();
  const { disk: root } = await rootDisk();
  const disks = (await sh("lsblk", ["-dnpo", "NAME,TYPE,RO"]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, type, ro]) => name && type === "disk" && ro === "0" && name !== root);
  for (const [disk] of disks) {
    if (!disk) continue;
    // blkid exits 2 when there's nothing on it.
    const used = await run("blkid", ["-p", disk]).then(
      () => true,
      () => false,
    );
    if (used) continue;
    log(`making ${disk} its home disk`);
    await sh("mkfs.ext4", ["-q", "-L", HOME_LABEL, disk]);
    return disk;
  }
  throw new Error("There's no disk for its home");
}

/** Mounts the home disk, seeding it from the image the first time, as Docker seeds a new volume. */
async function mountHome(log: (m: string) => void): Promise<void> {
  const mounted = (await sh("findmnt", ["-no", "TARGET", HOME]).catch(() => "")).trim();
  if (mounted) return;
  await mkdir(DATA, { recursive: true });
  await sh("mount", [await homeDisk(log), DATA]);
  const home = `${DATA}/home`;
  if (!(await exists(home))) {
    await sh("cp", ["-a", `${HOME}/.`, `${home}.new`]).catch(async () => {
      await mkdir(`${home}.new`, { recursive: true });
    });
    await sh("mv", [`${home}.new`, home]);
  }
  await sh("mount", ["--bind", home, HOME]);
  const tailscale = `${DATA}/tailscale`;
  await mkdir(tailscale, { recursive: true, mode: 0o700 });
  await sh("chown", [`${TAILSCALE_UID}:${TAILSCALE_GID}`, tailscale]);
  await mkdir(TAILSCALE_STATE, { recursive: true });
  await sh("mount", ["--bind", tailscale, TAILSCALE_STATE]);
}

/** DNS servers from systemd-networkd's DHCP lease, once it has one. */
async function leaseDns(timeoutMs: number): Promise<{ dns: string[]; router: string | null }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const dir = "/run/systemd/netif/leases";
    for (const file of await readdir(dir).catch(() => [])) {
      const text = await readFile(`${dir}/${file}`, "utf8").catch(() => "");
      const dns = /^DNS=(.+)$/m.exec(text)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
      const router = /^ROUTER=(\S+)/m.exec(text)?.[1] ?? null;
      if (dns.length) return { dns, router };
    }
    await sleep(500);
  }
  return { dns: [], router: null };
}

/**
 * The network: the lease's nameservers in resolv.conf (the entry lets DNS
 * through to exactly these), and the hosts file pointing the server and the
 * credential proxy at the agent on loopback, and `host.docker.internal` at
 * the host, as a container has it.
 */
async function network(log: (m: string) => void): Promise<void> {
  const { dns, router } = await leaseDns(30_000);
  if (dns.length)
    await writeFile("/etc/resolv.conf", dns.map((ip) => `nameserver ${ip}\n`).join(""));
  else log("no DHCP lease in 30 seconds; carrying on without DNS");
  const hosts = [
    "127.0.0.1 localhost server credproxy",
    "::1 localhost",
    ...(router ? [`${router} host.docker.internal`] : []),
  ];
  await writeFile("/etc/hosts", `${hosts.join("\n")}\n`);
}

/** A character device as a stream: reads and writes on the thread pool, as the device allows. */
class DeviceStream extends Duplex {
  private readonly handle: FileHandle;
  private reading = false;

  constructor(handle: FileHandle) {
    super();
    this.handle = handle;
  }

  override _read(): void {
    if (this.reading) return;
    this.reading = true;
    const buffer = Buffer.allocUnsafe(65536);
    this.handle.read(buffer, 0, buffer.length, null).then(
      ({ bytesRead }) => {
        this.reading = false;
        // A virtio port reads 0 while the host's end is closed: wait and try again.
        if (bytesRead === 0) setTimeout(() => this._read(), 200);
        else if (this.push(buffer.subarray(0, bytesRead))) this._read();
      },
      (err: Error) => this.destroy(err),
    );
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    const write = async () => {
      let at = 0;
      while (at < chunk.length) at += (await this.handle.write(chunk, at)).bytesWritten;
    };
    write().then(
      () => done(),
      (err: NodeJS.ErrnoException) =>
        // Nobody's on the host's end (a KVM port between bridges): what was said is lost, as on a wire.
        err.code === "EPIPE" ? done() : done(err),
    );
  }

  override _destroy(err: Error | null, done: (err?: Error | null) => void): void {
    this.handle.close().then(
      () => done(err),
      () => done(err),
    );
  }
}

export const linux: GuestPlugin = {
  os: "linux",

  async prepare(log) {
    await growRoot(log);
    await mountHome(log);
    await network(log);
  },

  async openPort(log) {
    // On Hyper-V, a Hyper-V socket: a COM port there loses what comes in.
    if (await exists("/sys/bus/vmbus/devices")) {
      await sh("modprobe", ["hv_sock"]).catch(() => "");
      log(`talking to the host on Hyper-V socket port ${HYPERV_AGENT_PORT}`);
      return relayStream("python3", [HVSOCK_RELAY, String(HYPERV_AGENT_PORT)]);
    }
    // On Apple Virtualization, vsock, to the port the host listens on: the
    // virtio console it also offers is a tty, which stalled for good on a
    // fresh VM's first boot. Elsewhere there's no host there, and it's on
    // to the console ports.
    if (await exists("/dev/vsock")) {
      const probe = await run(
        "python3",
        [HVSOCK_RELAY, "--connect", String(APPLE_AGENT_VSOCK_PORT), "--probe"],
        { timeout: 10_000 },
      ).then(
        () => true,
        () => false,
      );
      if (probe) {
        log(`talking to the host on vsock port ${APPLE_AGENT_VSOCK_PORT}`);
        return relayStream(
          "python3",
          [HVSOCK_RELAY, "--connect", String(APPLE_AGENT_VSOCK_PORT)],
          log,
        );
      }
    }
    // udev names the port a moment after boot.
    for (let attempt = 0; attempt < 60; attempt++) {
      for (const path of PORTS) {
        if (!(await exists(path))) continue;
        const handle = await open(path, "r+");
        // A tty turns bytes into lines and echoes them back; this one carries
        // frames. Set while it's open here, since a tty no one has open forgets.
        // A COM port (Hyper-V's) also goes at its baud rate, 9600 unless it's
        // told otherwise, so it's told the most a UART does; and a line with
        // no modem on it mustn't take a missing carrier for a hang-up. A
        // virtio console (Apple's hvc1) has no speed to set.
        if (!path.startsWith("/dev/virtio-ports/")) {
          const uart = path.startsWith("/dev/ttyS") ? ["115200", "clocal", "-crtscts"] : [];
          await sh("stty", ["-F", path, ...uart, "raw", "-echo", "-echoe", "-echok", "-echoctl"]);
        }
        log(`talking to the host on ${path}`);
        return new DeviceStream(handle);
      }
      await sleep(500);
    }
    throw new Error(`no port to the host (looked for ${PORTS.join(", ")})`);
  },

  entry(command, args) {
    return { file: process.execPath, argv: [ENTRY, ...entryArgv(command, args)] };
  },

  async poweroff() {
    // Queued, not waited for: stopping this service ends whatever it's waiting on.
    await sh("systemctl", ["--no-block", "poweroff"]);
  },

  // An archive that was killed before it could thaw its home disk mustn't leave it frozen.
  async afterRun(command) {
    if (command === "archive-home") await sh("fsfreeze", ["-u", DATA]).catch(() => "");
  },
};
