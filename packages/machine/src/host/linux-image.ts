import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GUEST_PORT_NAME } from "@nibblet/protocol";

/** The root partition's id, which the boot entry names it by. */
const ROOT_UUID = "6e1bb1e7-5d0d-4c3b-9a43-6e6962626c74";

/**
 * Linux guests run the runner image itself, so a nibblet in a VM has
 * exactly what one in a container has. This adds what a VM needs and a
 * container never did: a kernel, systemd, DHCP, and the guest agent's
 * service. It's built as an image of its own for a moment, then exported
 * into the disk (see DISK_SCRIPT) and removed.
 */
export const GUEST_DOCKERFILE = String.raw`ARG RUNNER
FROM ${"${RUNNER}"}
LABEL nibblet.image=runner-vm
USER root
# What a VM boots, which a container never needed: a kernel, an init, and
# DHCP (systemd-networkd; the guest agent writes resolv.conf from its lease).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      linux-image-$(dpkg --print-architecture) systemd systemd-sysv systemd-timesyncd \
      udev kmod iproute2 cloud-guest-utils e2fsprogs \
 && rm -rf /var/lib/apt/lists/*
# The image's own environment, which systemd doesn't give the agent the way Docker would.
RUN mkdir -p /etc/nibblet \
 && env | grep -vE '^(HOSTNAME|HOME|PWD|SHLVL|TERM|_)=' > /etc/nibblet/image.env
COPY <<'EOF' /etc/systemd/network/80-nibblet.network
[Match]
Type=ether

[Network]
DHCP=yes
EOF
COPY <<'EOF' /etc/systemd/system/nibblet-agent.service
[Unit]
Description=Nibblets guest agent, the server's way into this machine (${GUEST_PORT_NAME})
After=local-fs.target systemd-networkd.service systemd-udevd.service
Wants=systemd-networkd.service

[Service]
EnvironmentFile=/etc/nibblet/image.env
ExecStart=/usr/local/bin/node /app/apps/runner/src/machine/agent.ts
# To the console too, which the host keeps, for when it can't say why itself.
StandardOutput=journal+console
StandardError=journal+console
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
# Tailscale's package enables its own daemon; the entry runs Tailscale itself,
# as its own user, only for a nibblet on a tailnet.
RUN systemctl enable systemd-networkd nibblet-agent.service \
 && systemctl mask systemd-networkd-wait-online.service tailscaled.service \
 && echo "PARTUUID=${ROOT_UUID} / ext4 defaults,discard 0 1" > /etc/fstab
`;

/** A small image with the tools that lay a disk out, kept for next time. */
export const TOOLS_IMAGE = "nibblet/vm-disk-tools:1";
const TOOLS_DOCKERFILE = `FROM debian:trixie-slim
LABEL nibblet.image=vm-disk-tools
RUN apt-get update \\
 && apt-get install -y --no-install-recommends e2fsprogs dosfstools mtools fdisk qemu-utils systemd-boot-efi \\
 && rm -rf /var/lib/apt/lists/*
`;

/**
 * Lays the guest's filesystem (a tar on stdin, from `docker export`) out
 * as a bootable disk in /out: an EFI system partition with systemd-boot,
 * the kernel and its initramfs, and an ext4 root made with `mke2fs -d`
 * straight into the disk at its offset, without root or loop devices.
 * The only copy is the one unpacked in this throwaway container. The disk
 * is only as big as what's on it; each VM's copy is grown, and the guest
 * agent grows the root to fill it on boot.
 */
const DISK_SCRIPT = String.raw`set -eu
format="$1"
# On arm64, no SME: M4 Macs have it, and Linux guests that use it under
# Apple's hypervisor corrupt their own memory.
case "$(dpkg --print-architecture)" in
  amd64) efi=x64; extra="" ;;
  arm64) efi=aa64; extra=" arm64.nosme" ;;
  *) echo "no EFI loader for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
efi_upper=$(echo "$efi" | tr a-z A-Z)
R=/rootfs
mkdir -p "$R"
tar -xpf - -C "$R" --numeric-owner
kver=$(ls "$R/lib/modules" | sort -V | tail -n1)
# Docker's stand-ins for what it mounts over them at run time.
rm -f "$R/.dockerenv"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$R/etc/hosts"
echo nibblet > "$R/etc/hostname"
: > "$R/etc/resolv.conf"
mkdir -p "$R/proc" "$R/sys" "$R/dev" "$R/run" "$R/tmp"
chmod 1777 "$R/tmp"

mkdir -p /esp/EFI/BOOT /esp/loader/entries
cp "/usr/lib/systemd/boot/efi/systemd-boot$efi.efi" "/esp/EFI/BOOT/BOOT$efi_upper.EFI"
cp "$R/boot/vmlinuz-$kver" /esp/vmlinuz
cp "$R/boot/initrd.img-$kver" /esp/initrd.img
printf 'default nibblet.conf\ntimeout 0\n' > /esp/loader/loader.conf
printf 'title Nibblet\nlinux /vmlinuz\ninitrd /initrd.img\noptions root=PARTUUID=%s rw console=tty0 console=ttyS0,115200 console=hvc0 loglevel=4 systemd.gpt_auto=0%s\n' \
  "${ROOT_UUID}" "$extra" > /esp/loader/entries/nibblet.conf
esp_mb=$(( $(du -sm /esp | cut -f1) + 64 ))
truncate -s "${"${esp_mb}"}M" /esp.img
mkfs.vfat -F 32 -n EFI /esp.img >/dev/null
mcopy -s -i /esp.img /esp/* ::/

used_mb=$(du -sxm "$R" | cut -f1)
root_mb=$(( used_mb + used_mb / 5 + 512 ))
total_mb=$(( 1 + esp_mb + root_mb + 1 ))
disk=/out/disk.img
truncate -s "${"${total_mb}"}M" "$disk"
sfdisk -q "$disk" <<PARTS
label: gpt
start=1MiB, size=${"${esp_mb}"}MiB, type=U, name=esp
size=${"${root_mb}"}MiB, type=L, uuid=${ROOT_UUID}, name=root
PARTS
dd if=/esp.img of="$disk" bs=1M seek=1 conv=notrunc status=none
mke2fs -q -F -t ext4 -L nibblet-root -E offset=$(( (1 + esp_mb) * 1048576 )) -d "$R" "$disk" "${"${root_mb}"}M"
rm -rf "$R"
if [ "$format" = vhdx ]; then
  qemu-img convert -f raw -O vhdx -o subformat=dynamic "$disk" /out/disk.vhdx
  rm "$disk"
fi
`;

/** The disk file in an image's folder. */
export const linuxDiskFile = (format: "raw" | "vhdx"): string =>
  format === "vhdx" ? "disk.vhdx" : "disk.img";

/** About what making one needs free, on the host's disk: the disk itself and some room. */
const NEEDS_GB = 12;

/** Runs the Docker CLI, keeping the end of what it says for saying why it failed. */
function docker(
  cli: string,
  args: string[],
  opts: { stdin?: string | NodeJS.ReadableStream; onLine?: (line: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let tail = "";
    const lines = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      lines(chunk);
    });
    child.stderr.on("data", lines);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(`docker ${args[0]} failed: ${tail.trim().split("\n").slice(-6).join(" ")}`),
          ),
    );
    // One that stops reading early says why when it exits; that's the error worth having.
    child.stdin.on("error", () => {});
    if (typeof opts.stdin === "string" || opts.stdin === undefined)
      child.stdin.end(opts.stdin ?? "");
    else opts.stdin.pipe(child.stdin);
  });
}

/** The id the engine knows an image by now. */
export async function imageId(cli: string, image: string): Promise<string> {
  return (await docker(cli, ["image", "inspect", "--format", "{{.Id}}", image])).trim();
}

/** Builds an image from a Dockerfile alone, with an empty context. */
async function buildImage(
  cli: string,
  dockerfile: string,
  tag: string,
  args: Record<string, string>,
  onLine: (line: string) => void,
): Promise<void> {
  const context = await mkdtemp(join(tmpdir(), "nibblet-image-"));
  try {
    await docker(
      cli,
      [
        "build",
        "--progress=plain",
        ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
        "-t",
        tag,
        "-f",
        "-",
        context,
      ],
      { stdin: dockerfile, onLine },
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

/**
 * Makes a Linux guest's disk from `runnerImage` into `dir`, in the
 * hypervisor's format, saying how it's going. Returns the runner image's
 * id, which the image is then known to be made from.
 */
export async function buildLinuxImage(opts: {
  docker: string;
  runnerImage: string;
  format: "raw" | "vhdx";
  dir: string;
  progress: (fraction: number | null, detail: string | null) => void;
}): Promise<string> {
  const free = await statfs(opts.dir).then((s) => (s.bavail * s.bsize) / 1024 ** 3);
  if (free < NEEDS_GB) {
    throw new Error(
      `There's only ${free.toFixed(1)} GB free here, and making a Linux image needs about ${NEEDS_GB} GB`,
    );
  }
  const cli = opts.docker;
  const id = await imageId(cli, opts.runnerImage);
  const tag = `nibblet/runner-vm:${id.replace(/^sha256:/, "").slice(0, 12)}`;
  const name = `nibblet-vm-export-${randomBytes(4).toString("hex")}`;
  try {
    opts.progress(0.05, "Adding a kernel and systemd to the runner image");
    await buildImage(cli, GUEST_DOCKERFILE, tag, { RUNNER: opts.runnerImage }, (line) => {
      const step = /^#\d+ \[(\d+)\/(\d+)\]/.exec(line);
      if (step) opts.progress(0.05 + (Number(step[1]) / Number(step[2])) * 0.45, null);
    });
    opts.progress(0.5, "Getting the tools to lay out a disk");
    await buildImage(cli, TOOLS_DOCKERFILE, TOOLS_IMAGE, {}, () => {});
    opts.progress(0.55, "Copying the runner image onto a disk");
    await docker(cli, ["create", "--name", name, tag, "true"]);
    const exported = spawn(cli, ["export", name], { stdio: ["ignore", "pipe", "inherit"] });
    await docker(
      cli,
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "-v",
        `${resolve(opts.dir)}:/out`,
        TOOLS_IMAGE,
        "sh",
        "-c",
        DISK_SCRIPT,
        "disk",
        opts.format,
      ],
      { stdin: exported.stdout },
    );
    opts.progress(0.99, "Tidying up");
  } finally {
    await docker(cli, ["rm", "-f", name]).catch(() => undefined);
    await docker(cli, ["rmi", tag]).catch(() => undefined);
  }
  return id;
}
