import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import {
  connectTo,
  sleep,
  socketPath,
  type HostContext,
  type ImageJob,
} from "@nibblets/machine/host";
import { z } from "zod";

const run = promisify(execFile);

/** How long its first boot runs before it's shut down. */
const FIRST_BOOT_MS = 3 * 60_000;

/**
 * Giving a fresh macOS guest the guest agent, without anyone at its
 * screen: macOS has no answer file, and its Setup Assistant wants a person.
 * So it's booted once for the system to set itself up (its privacy
 * database among it), then the guest's Data volume is mounted here and
 * given a LaunchDaemon (bootstrap.sh, as root, at every boot), the host's
 * own VM helper (for `guest-relay`, its port to the host), the mark that
 * says setup's been done, and OpenComputerUse's permissions (Accessibility
 * and Screen Recording, which only a person can give otherwise, and which
 * the running guest's own root can't). Writing root's files needs an
 * administrator, so macOS asks for one's password, once. Then it's booted
 * again to install Node, the runner, OpenComputerUse, Google Chrome and
 * Tailscale, and shuts itself down: the image is made.
 */

/** The OpenComputerUse release macOS guests run, for their browser and desktop. */
export const MACOS_OCU_VERSION = "0.11.1";

/** Who signs what the bootstrap downloads: OpenComputerUse's developer, and Google. */
export const OCU_REQUIREMENT =
  'identifier "com.infrawrench.opencomputeruse" and anchor apple generic and certificate leaf[subject.OU] = "CS54L4CF2Z"';
const CHROME_REQUIREMENT =
  'identifier "com.google.Chrome" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';

/** What OpenComputerUse may do without asking anyone: see windows, and drive them. */
export const OCU_SERVICES = [
  "kTCCServiceAccessibility",
  "kTCCServiceScreenCapture",
  "kTCCServicePostEvent",
];

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

/**
 * At every boot, as root: Node and the runner (again for a new release),
 * OpenComputerUse, Google Chrome and Tailscale, each once, then the guest
 * agent. What it downloads is checked: Node's against its sums, the apps'
 * signatures against their developers', and Tailscale is built from source
 * through Go's checksummed module proxy (there's no build of its daemon
 * alone for macOS). Chrome is given its policies at every boot.
 */
export const BOOTSTRAP_SH = `#!/bin/sh
set -eu
root=/Library/Nibblets
exec >>"$root/bootstrap.log" 2>&1
echo "bootstrap: $(date)"
repo=$(plutil -extract repo raw -o - "$root/install.json")
ref=$(plutil -extract ref raw -o - "$root/install.json")
ocu=$(plutil -extract ocu raw -o - "$root/install.json")
get() { curl -fsSL --retry 20 --retry-all-errors --retry-delay 5 "$@"; }

# While the image is being made, each step is said to the host too, over the
# agent's port, and a step that fails is said with the end of the log, and
# the guest shut down: the host stops waiting at once and says why.
step="Starting"
tell() { printf '%s\\n' "$1" | "$root/bin/nibblet-vm" guest-relay >/dev/null 2>&1 || true; }
say() {
  step="$1"
  echo "bootstrap: $1"
  if [ -e "$root/preparing" ]; then tell "$1"; fi
}
failed() {
  code=$?
  if [ "$code" = 0 ] || [ ! -e "$root/preparing" ]; then return; fi
  tell "failed: $step ($(tail -n 4 "$root/bootstrap.log" | tr '\\n' ' '))"
  shutdown -h now
}
trap failed EXIT

if [ ! -x "$root/node/bin/node" ]; then
  say "Installing Node"
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
  say "Installing the runner"
  get "https://github.com/$repo/archive/$ref.tar.gz" -o "$root/app.tgz"
  rm -rf "$root/app" && mkdir -p "$root/app"
  tar -xzf "$root/app.tgz" -C "$root/app" --strip-components 1
  rm -f "$root/app.tgz"
  cd "$root/app"
  PATH="$root/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \\
    "$root/node/bin/corepack" pnpm install --prod --frozen-lockfile --filter '@nibblets/runner...'
  # Installs drop the execute bit from node-pty's helper; the terminals need it.
  chmod 755 node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
  echo "$want" > "$root/app/.nibblets"
fi

if [ "$(cat "$root/ocu.version" 2>/dev/null || true)" != "$ocu" ]; then
  say "Installing OpenComputerUse $ocu"
  rm -rf "$root/ocu" && mkdir -p "$root/ocu"
  get "https://github.com/IAmJSD/OpenComputerUse/releases/download/v$ocu/OpenComputerUse.zip" -o "$root/ocu.zip"
  ditto -x -k "$root/ocu.zip" "$root/ocu"
  codesign --verify --deep --strict -R='${OCU_REQUIREMENT}' "$root/ocu/OpenComputerUse.app"
  rm -rf /Applications/OpenComputerUse.app
  mv "$root/ocu/OpenComputerUse.app" /Applications/
  rm -rf "$root/ocu" "$root/ocu.zip"
  echo "$ocu" > "$root/ocu.version"
fi

if [ ! -d "/Applications/Google Chrome.app" ]; then
  say "Installing Google Chrome"
  get https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg -o "$root/chrome.dmg"
  rm -rf "$root/chrome.app"
  dmg=$(mktemp -d /private/tmp/nibblet-chrome.XXXXXX)
  hdiutil attach -nobrowse -readonly -mountpoint "$dmg" "$root/chrome.dmg" >/dev/null
  # Copied out first, so the disk image is let go of however the copy goes.
  copied=0
  ditto "$dmg/Google Chrome.app" "$root/chrome.app" || copied=$?
  hdiutil detach -force "$dmg" >/dev/null || true
  rm -f "$root/chrome.dmg"
  [ "$copied" = 0 ]
  # Not --strict: Google's own disk image leaves Finder information on a helper.
  codesign --verify --deep -R='${CHROME_REQUIREMENT}' "$root/chrome.app"
  mv "$root/chrome.app" "/Applications/Google Chrome.app"
fi
# Its profile on the home disk, and nothing in the way when OpenComputerUse starts it.
# Written as a file: cfprefsd won't write managed preferences itself.
policies="/Library/Managed Preferences/com.google.Chrome.plist"
mkdir -p "/Library/Managed Preferences"
rm -f "$policies.new"
plutil -create xml1 "$policies.new"
plutil -insert UserDataDir -string /Users/nibblet/.browser "$policies.new"
for policy in DefaultBrowserSettingEnabled BackgroundModeEnabled MetricsReportingEnabled PromotionalTabsEnabled; do
  plutil -insert "$policy" -bool NO "$policies.new"
done
chmod 644 "$policies.new"
mv -f "$policies.new" "$policies"

if [ ! -x "$root/tailscale/tailscaled" ]; then
  say "Building Tailscale"
  get "https://pkgs.tailscale.com/stable/?mode=json" -o "$root/tailscale.json"
  version=$(plutil -extract TarballsVersion raw -o - "$root/tailscale.json")
  go=$(get "https://go.dev/VERSION?m=text" | head -n 1)
  work=$(mktemp -d /private/tmp/nibblet-go.XXXXXX)
  get "https://dl.google.com/go/$go.darwin-arm64.tar.gz" -o "$work/go.tgz"
  echo "$(get "https://dl.google.com/go/$go.darwin-arm64.tar.gz.sha256")  $work/go.tgz" | shasum -a 256 -c -
  tar -xzf "$work/go.tgz" -C "$work"
  mkdir -p "$root/tailscale.new"
  GOPATH="$work/path" GOCACHE="$work/cache" GOTOOLCHAIN=auto CGO_ENABLED=0 GOBIN="$root/tailscale.new" \\
    "$work/go/bin/go" install "tailscale.com/cmd/tailscale@v$version" "tailscale.com/cmd/tailscaled@v$version"
  chmod -R u+w "$work" && rm -rf "$work" "$root/tailscale.json"
  rm -rf "$root/tailscale" && mv "$root/tailscale.new" "$root/tailscale"
fi

if [ -e "$root/preparing" ]; then
  say "Done"
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
# Mounted straight, with its owners: Disk Arbitration turns down a mount of a
# disk it's still looking at, and of one whose folder root made.
mount_apfs "$volume" "$mnt"
trap 'umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
install -d -o root -g wheel -m 755 "$mnt/Library/Nibblets" "$mnt/Library/Nibblets/bin" "$mnt/Library/LaunchDaemons"
install -o root -g wheel -m 755 "$files/bootstrap.sh" "$mnt/Library/Nibblets/bootstrap.sh"
install -o root -g wheel -m 644 "$files/install.json" "$mnt/Library/Nibblets/install.json"
install -o root -g wheel -m 755 "$files/nibblet-vm" "$mnt/Library/Nibblets/bin/nibblet-vm"
install -o root -g wheel -m 644 "$files/dev.nibblets.agent.plist" "$mnt/Library/LaunchDaemons/dev.nibblets.agent.plist"
touch "$mnt/Library/Nibblets/preparing"
# The system's privacy database, which its first boot made, and which only a
# person at its screen could add to otherwise.
tcc="$mnt/Library/Application Support/com.apple.TCC/TCC.db"
if [ ! -f "$tcc" ]; then echo "The guest's first boot made no privacy database" >&2; exit 1; fi
sqlite3 "$tcc" < "$files/tcc.sql"
install -d -o root -g wheel "$mnt/private/var/db"
touch "$mnt/private/var/db/.AppleSetupDone"
chown root:wheel "$mnt/private/var/db/.AppleSetupDone"
`;

/** A code signing requirement, compiled to the form TCC keeps, as hex. */
async function compiledRequirement(requirement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("csreq", ["-r-", "-b", "/dev/stdout"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString("hex"))
        : reject(new Error(err.trim() || `csreq exited ${code}`)),
    );
    child.stdin.end(requirement);
  });
}

/**
 * OpenComputerUse's rows in the guest's privacy database: allowed, as
 * System Settings would have it, for the app its developer signed alone.
 */
export function tccSql(csreqHex: string): string {
  if (!/^[0-9a-f]+$/.test(csreqHex)) throw new Error("not a compiled requirement");
  return `${OCU_SERVICES.map(
    (service) =>
      `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags) VALUES ('${service}', 'com.infrawrench.opencomputeruse', 0, 2, 4, 1, X'${csreqHex}', 0);`,
  ).join("\n")}\n`;
}

const tccRows = async () => tccSql(await compiledRequirement(OCU_REQUIREMENT));

interface Boot {
  name: string;
  /** How long it may run; then it's asked to shut down (`stop`), or turned off and failed (`fail`). */
  limitMs: number;
  onLimit: "fail" | "stop";
  /** What the bootstrap says it's doing, over the agent's port; it fails at once if a step does. */
  say?: (step: string) => void;
  /** How long it may say nothing before it's taken to be stuck. */
  quietMs?: number;
}

/** What the bootstrap says when a step fails (BOOTSTRAP_SH's `failed`). */
const FAILED = "failed: ";

/** Boots the image's disk with the helper until it stops, or its limit. */
async function boot(helper: string, job: ImageJob, b: Boot): Promise<void> {
  const spec = join(job.dir, `${b.name}.json`);
  // Not beside the image: a unix socket's path is short, and the image's folder may be deep.
  const socket = socketPath("apple", `image-${b.name}`, "agent");
  await writeFile(
    spec,
    JSON.stringify({
      guest: "macos",
      cpus: 4,
      // Enough to install and build in, beside whatever else the host runs.
      memoryMb: 4096,
      disks: [{ path: join(job.dir, "disk.img"), readOnly: false }],
      efiVariables: null,
      macos: {
        hardwareModel: join(job.dir, "hardware-model"),
        machineIdentifier: join(job.dir, "machine-identifier"),
        auxiliaryStorage: join(job.dir, "aux.img"),
      },
      macAddress: "02:6e:69:62:62:6c",
      console: join(job.dir, `${b.name}.log`),
      agentSocket: socket,
      state: join(job.dir, `${b.name}.state`),
    }),
  );
  // Kept here, for `finally` to close: it's connected from inside the promise.
  const link: { port: Duplex | null } = { port: null };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(helper, ["run", spec], { stdio: "ignore" });
      let exited = false;
      let limited = false;
      let failed: string | null = null;
      let step = "starting";
      let heard = Date.now();
      const timer = setTimeout(() => {
        limited = true;
        // Asked to shut down, then turned off if it doesn't.
        child.kill(b.onLimit === "stop" ? "SIGTERM" : "SIGINT");
        if (b.onLimit === "fail")
          reject(new Error(`Its ${b.name} boot took too long (at: ${step})`));
      }, b.limitMs);
      const quiet = setInterval(() => {
        if (!b.quietMs || Date.now() - heard < b.quietMs) return;
        clearInterval(quiet);
        child.kill("SIGINT");
        reject(
          new Error(
            `It's said nothing for ${Math.round(b.quietMs / 60_000)} minutes (at: ${step})`,
          ),
        );
      }, 30_000);
      const said = (line: string) => {
        heard = Date.now();
        if (line.startsWith(FAILED)) failed = line.slice(FAILED.length);
        else {
          step = line;
          b.say?.(line);
        }
      };
      // The helper makes the agent's socket as it starts.
      const listen = async () => {
        while (b.say && !exited && !link.port) {
          link.port = await connectTo(socket).catch(() => null);
          if (!link.port) await sleep(500);
        }
        let buffer = "";
        link.port?.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            said(buffer.slice(0, nl).trim());
            buffer = buffer.slice(nl + 1);
          }
        });
        link.port?.on("error", () => {});
      };
      void listen();
      child.once("error", reject);
      child.once("exit", (code) => {
        exited = true;
        clearTimeout(timer);
        clearInterval(quiet);
        if (failed) reject(new Error(`Making its macOS image failed: ${failed}`));
        else if (code === 0 || (limited && b.onLimit === "stop")) resolve();
        else reject(new Error(`Its ${b.name} boot stopped with ${code}`));
      });
    });
  } finally {
    link.port?.destroy();
    for (const ext of ["json", "state"])
      await rm(join(job.dir, `${b.name}.${ext}`), { force: true });
    await rm(socket, { force: true });
  }
}

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
  await writeFile(
    join(files, "install.json"),
    JSON.stringify({ repo: job.repo, ref: job.ref, ocu: MACOS_OCU_VERSION }),
  );
  await writeFile(join(files, "tcc.sql"), await tccRows());
  await writeFile(join(files, "dev.nibblets.agent.plist"), LAUNCH_DAEMON);
  await copyFile(helper, join(files, "nibblet-vm"));
  const script = join(files, "provision.sh");
  await writeFile(script, PROVISION_SH);

  // Its first boot, to Setup Assistant: long enough for the system to make what's its own.
  job.progress(0.9, "Starting macOS for the first time");
  await boot(helper, job, { name: "first", limitMs: FIRST_BOOT_MS, onLimit: "stop" });

  job.progress(0.91, "Giving it the Nibblets guest agent (it asks for your password)");
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

  // Booted again, to install what it runs; it shuts itself down when it has.
  job.progress(0.92, "Installing the runner, OpenComputerUse, Chrome and Tailscale in it");
  await boot(helper, job, {
    name: "prepare",
    limitMs: 60 * 60_000,
    onLimit: "fail",
    say: (step) => job.progress(0.92, step),
    // Building Tailscale is the longest step, and says nothing for ten minutes or so.
    quietMs: 25 * 60_000,
  });
  ctx.log("its macOS image is made");
}
