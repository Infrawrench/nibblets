import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HostContext, ImageJob } from "@nibblet/machine/host";
import { z } from "zod";

const run = promisify(execFile);

/**
 * Giving a fresh macOS guest the guest agent, without anyone at its
 * screen: macOS has no answer file, and its Setup Assistant wants a person.
 * So the guest's Data volume is mounted here and given a LaunchDaemon
 * (bootstrap.sh, as root, at every boot), the host's own VM helper (for
 * `guest-relay`, its port to the host), and the mark that says setup's been
 * done. Writing root's files needs an administrator, so macOS asks for
 * one's password, once. Then it's booted once to install Node and the
 * runner, and shuts itself down: the image is made.
 */

export const LAUNCH_DAEMON = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.nibblets.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/Library/Nibblets/bootstrap.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;

/** At every boot, as root: Node and the runner, once (again for a new release), then the guest agent. */
export const BOOTSTRAP_SH = `#!/bin/sh
set -eu
root=/Library/Nibblets
exec >>"$root/bootstrap.log" 2>&1
echo "bootstrap: $(date)"
repo=$(plutil -extract repo raw -o - "$root/install.json")
ref=$(plutil -extract ref raw -o - "$root/install.json")
get() { curl -fsSL --retry 20 --retry-all-errors --retry-delay 5 "$@"; }

if [ ! -x "$root/node/bin/node" ]; then
  base=https://nodejs.org/dist/latest-v24.x
  get "$base/SHASUMS256.txt" -o "$root/node-sums.txt"
  file=$(awk '/node-v24\\.[0-9.]+-darwin-arm64\\.tar\\.gz$/ {print $2; exit}' "$root/node-sums.txt")
  sum=$(awk -v f="$file" '$2 == f {print $1}' "$root/node-sums.txt")
  get "$base/$file" -o "$root/node.tgz"
  echo "$sum  $root/node.tgz" | shasum -a 256 -c -
  rm -rf "$root/node" && mkdir -p "$root/node"
  tar -xzf "$root/node.tgz" -C "$root/node" --strip-components 1
  rm -f "$root/node.tgz" "$root/node-sums.txt"
fi

want="$repo@$ref"
if [ "$(cat "$root/app/.nibblets" 2>/dev/null || true)" != "$want" ]; then
  get "https://github.com/$repo/archive/$ref.tar.gz" -o "$root/app.tgz"
  rm -rf "$root/app" && mkdir -p "$root/app"
  tar -xzf "$root/app.tgz" -C "$root/app" --strip-components 1
  rm -f "$root/app.tgz"
  cd "$root/app"
  PATH="$root/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \\
    "$root/node/bin/corepack" pnpm install --prod --frozen-lockfile --filter '@nibblet/runner...'
  # Installs drop the execute bit from node-pty's helper; the terminals need it.
  chmod 755 node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  echo "$want" > "$root/app/.nibblets"
fi

if [ -e "$root/preparing" ]; then
  rm -f "$root/preparing"
  shutdown -h now
  exit 0
fi
exec "$root/node/bin/node" "$root/app/apps/runner/src/machine/agent.ts"
`;

/** Run as root, by osascript: the guest's Data volume, given the files beside it. */
const PROVISION_SH = `#!/bin/sh
set -eu
volume="/dev/$1"
files="$2"
mnt=$(mktemp -d /private/tmp/nibblet-macos.XXXXXX)
diskutil mount -mountPoint "$mnt" "$volume" >/dev/null
diskutil enableOwnership "$volume" >/dev/null
trap 'diskutil unmount "$mnt" >/dev/null 2>&1 || true; rmdir "$mnt" 2>/dev/null || true' EXIT
install -d -o root -g wheel -m 755 "$mnt/Library/Nibblets" "$mnt/Library/Nibblets/bin" "$mnt/Library/LaunchDaemons"
install -o root -g wheel -m 755 "$files/bootstrap.sh" "$mnt/Library/Nibblets/bootstrap.sh"
install -o root -g wheel -m 644 "$files/install.json" "$mnt/Library/Nibblets/install.json"
install -o root -g wheel -m 755 "$files/nibblet-vm" "$mnt/Library/Nibblets/bin/nibblet-vm"
install -o root -g wheel -m 644 "$files/dev.nibblets.agent.plist" "$mnt/Library/LaunchDaemons/dev.nibblets.agent.plist"
touch "$mnt/Library/Nibblets/preparing"
install -d -o root -g wheel "$mnt/private/var/db"
touch "$mnt/private/var/db/.AppleSetupDone"
chown root:wheel "$mnt/private/var/db/.AppleSetupDone"
`;

/** A plist, as JSON, through plutil. */
async function plistJson(plist: string): Promise<unknown> {
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
  return JSON.parse(json);
}

const Attached = z.object({
  "system-entities": z.array(
    z.object({ "dev-entry": z.string(), "content-hint": z.string().optional() }),
  ),
});

const ApfsList = z.object({
  Containers: z.array(
    z.object({
      DesignatedPhysicalStore: z.string(),
      Volumes: z.array(z.object({ DeviceIdentifier: z.string(), Roles: z.array(z.string()) })),
    }),
  ),
});

/** Shell's single quotes, for paths of ours (which have none in them). */
function quoted(s: string): string {
  if (s.includes("'")) throw new Error(`can't quote ${s}`);
  return `'${s}'`;
}

export async function provisionMacos(
  ctx: HostContext,
  helper: string,
  job: ImageJob,
): Promise<void> {
  const files = join(job.dir, "provision");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "bootstrap.sh"), BOOTSTRAP_SH);
  await writeFile(join(files, "install.json"), JSON.stringify({ repo: job.repo, ref: job.ref }));
  await writeFile(join(files, "dev.nibblets.agent.plist"), LAUNCH_DAEMON);
  await copyFile(helper, join(files, "nibblet-vm"));
  const script = join(files, "provision.sh");
  await writeFile(script, PROVISION_SH);

  job.progress(0.9, "Giving it the Nibblets guest agent (it asks for your password)");
  const attached = Attached.parse(
    await plistJson(
      (
        await run("hdiutil", [
          "attach",
          "-nomount",
          "-plist",
          "-imagekey",
          "diskimage-class=CRawDiskImage",
          join(job.dir, "disk.img"),
        ])
      ).stdout,
    ),
  );
  const whole = attached["system-entities"].find((e) => /^\/dev\/disk\d+$/.test(e["dev-entry"]));
  try {
    const store = attached["system-entities"]
      .find((e) => e["content-hint"] === "Apple_APFS")
      ?.["dev-entry"].replace("/dev/", "");
    if (!store) throw new Error("The guest's disk has no APFS container");
    const apfs = ApfsList.parse(
      await plistJson((await run("diskutil", ["apfs", "list", "-plist"])).stdout),
    );
    const data = apfs.Containers.find((c) => c.DesignatedPhysicalStore === store)?.Volumes.find(
      (v) => v.Roles.includes("Data"),
    )?.DeviceIdentifier;
    if (!data) throw new Error("The guest's disk has no Data volume");
    const command = `/bin/sh ${quoted(script)} ${quoted(data)} ${quoted(files)}`;
    await run("osascript", [
      "-e",
      `do shell script "${command}" with prompt "Nibblets needs to finish setting up a macOS virtual machine." with administrator privileges`,
    ]).catch((err: unknown) => {
      throw new Error(
        `Couldn't finish its macOS image (it needs an administrator's password, in a window on this Mac): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } finally {
    if (whole)
      await run("hdiutil", ["detach", "-force", whole["dev-entry"]]).catch(() => undefined);
  }
  await rm(files, { recursive: true, force: true });

  // Booted once, to install Node and the runner; it shuts itself down when it has.
  job.progress(0.92, "Installing the runner in it");
  const spec = join(job.dir, "prepare.json");
  await writeFile(
    spec,
    JSON.stringify({
      guest: "macos",
      cpus: 4,
      memoryMb: 8192,
      disks: [{ path: join(job.dir, "disk.img"), readOnly: false }],
      efiVariables: null,
      macos: {
        hardwareModel: join(job.dir, "hardware-model"),
        machineIdentifier: join(job.dir, "machine-identifier"),
        auxiliaryStorage: join(job.dir, "aux.img"),
      },
      macAddress: "02:6e:69:62:62:6c",
      console: join(job.dir, "prepare.log"),
      agentSocket: join(job.dir, "prepare.sock"),
      state: join(job.dir, "prepare.state"),
    }),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, ["run", spec], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGINT");
      reject(new Error("Installing the runner in macOS took too long"));
    }, 60 * 60_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Its first boot stopped with ${code}`));
    });
  });
  for (const f of ["prepare.json", "prepare.sock", "prepare.state"]) {
    await rm(join(job.dir, f), { force: true });
  }
  ctx.log("its macOS image is made");
}
