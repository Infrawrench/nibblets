import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { entryArgv, relayStream, type GuestPlugin } from "./guest.ts";

const run = promisify(execFile);
const HOME = "/Users/nibblet";
const HOME_VOLUME = "Nibblet Home";
/** The host's own VM helper, put in the guest when its image was made; its guest-relay is the port. */
export const GUEST_RELAY = "/Library/Nibblets/bin/nibblet-vm";
const ENTRY = fileURLToPath(new URL("../entry.ts", import.meta.url));
/** Where the agent's own lines go in the hosts file, so they're replaced, not added to. */
const HOSTS_MARK = "# Nibblets";

async function sh(cmd: string, args: string[]): Promise<string> {
  return (await run(cmd, args, { timeout: 120_000 })).stdout;
}

/** The hosts file, with its own lines replaced: what the agent points at itself, and the host. */
export function withHosts(hosts: string, gateway: string | null): string {
  const kept = hosts.split("\n").filter((line) => !line.endsWith(HOSTS_MARK));
  while (kept.length && kept.at(-1) === "") kept.pop();
  return [
    ...kept,
    `127.0.0.1 server credproxy ${HOSTS_MARK}`,
    ...(gateway ? [`${gateway} host.docker.internal ${HOSTS_MARK}`] : []),
    "",
  ].join("\n");
}

const DiskList = z.object({
  AllDisksAndPartitions: z.array(
    z.object({
      DeviceIdentifier: z.string(),
      Content: z.string().optional(),
      Partitions: z.array(z.object({})).optional(),
    }),
  ),
});

/** The physical disks, as diskutil sees them (through plutil, which makes its plist JSON). */
async function physicalDisks(): Promise<z.infer<typeof DiskList>["AllDisksAndPartitions"]> {
  const plist = await sh("diskutil", ["list", "-plist", "physical"]);
  const json = await new Promise<string>((resolve, reject) => {
    const child = spawn("plutil", ["-convert", "json", "-o", "-", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`plutil exited ${code}`)),
    );
    child.stdin.end(plist);
  });
  return DiskList.parse(JSON.parse(json)).AllDisksAndPartitions;
}

/**
 * The disk for its home: the one that's blank, made APFS the first time
 * (with ownership on, which an extra disk's volume doesn't have otherwise),
 * mounted over the agent's home folder.
 */
async function mountHome(log: (m: string) => void): Promise<void> {
  const mounted = await sh("mount", []);
  if (mounted.includes(` on ${HOME} `)) return;
  let device = await sh("diskutil", ["info", HOME_VOLUME]).then(
    (out) => /Device Node:\s*(\S+)/.exec(out)?.[1] ?? null,
    () => null,
  );
  if (!device) {
    // The boot disk has partitions; a new home disk has none.
    const blank = (await physicalDisks()).find(
      (d) => !d.Partitions?.length && !d.Content,
    )?.DeviceIdentifier;
    if (!blank) throw new Error("There's no disk for its home");
    log(`making ${blank} its home disk`);
    await sh("diskutil", ["eraseDisk", "APFS", HOME_VOLUME, "GPT", `/dev/${blank}`]);
    device = await sh("diskutil", ["info", HOME_VOLUME]).then(
      (out) => /Device Node:\s*(\S+)/.exec(out)?.[1] ?? null,
      () => null,
    );
    if (!device) throw new Error("Its home disk didn't come up");
  }
  await sh("diskutil", ["enableOwnership", device]).catch(() => "");
  await sh("diskutil", ["unmount", device]).catch(() => "");
  await mkdir(HOME, { recursive: true });
  await sh("diskutil", ["mount", "-mountPoint", HOME, device]);
}

async function network(): Promise<void> {
  const gateway = await sh("route", ["-n", "get", "default"]).then(
    (out) => /gateway:\s*(\S+)/.exec(out)?.[1] ?? null,
    () => null,
  );
  const hosts = await readFile("/etc/hosts", "utf8").catch(() => "");
  await writeFile("/etc/hosts", withHosts(hosts, gateway));
}

export const macos: GuestPlugin = {
  os: "macos",

  async prepare(log) {
    await mountHome(log);
    await network();
  },

  async openPort(log) {
    log("talking to the host over vsock");
    return relayStream(GUEST_RELAY, ["guest-relay"]);
  },

  entry(command, args) {
    return { file: process.execPath, argv: [ENTRY, ...entryArgv(command, args)] };
  },

  async poweroff() {
    await sh("shutdown", ["-h", "now"]);
  },
};
