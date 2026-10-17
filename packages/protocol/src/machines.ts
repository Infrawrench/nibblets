import { z } from "zod";

/**
 * Where a nibblet runs: its machine. A container on the stack's Docker
 * engine by default, or a virtual machine on the host, made by one of the
 * hypervisor plugins in `packages/machine-*`, running Linux, Windows or macOS.
 */

/** The operating system inside a nibblet's machine. */
export const GuestOs = z.enum(["linux", "windows", "macos"]);
export type GuestOs = z.infer<typeof GuestOs>;

export const GUEST_NAMES: Record<GuestOs, string> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
};

/** A machine plugin's id: `docker`, `apple`, `hyperv`. */
export const MachineBackendId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type MachineBackendId = z.infer<typeof MachineBackendId>;

/** Which plugin a nibblet's machine comes from, and what it runs. Fixed once it's made. */
export const MachineChoice = z.object({ backend: MachineBackendId, guest: GuestOs });
export type MachineChoice = z.infer<typeof MachineChoice>;

/** What every nibblet had before there was a choice, and what's recommended. */
export const DEFAULT_MACHINE: MachineChoice = { backend: "docker", guest: "linux" };

/** What a kind of machine can do, which differs by plugin and by guest. */
export const MachineCapabilities = z.object({
  /** The browser and the desktop for other apps, which come and go together. */
  browser: z.boolean(),
  /** Joining the user's tailnet as a machine of its own. */
  tailscale: z.boolean(),
  /** The host's SSH agent, shared into it. */
  sshAgent: z.boolean(),
  /** New CPU and memory limits apply while it runs, rather than when it next starts. */
  liveResources: z.boolean(),
});
export type MachineCapabilities = z.infer<typeof MachineCapabilities>;

/**
 * The image a guest's machines are made from. A container's is the runner
 * image, always there; a virtual machine's base disk has to be made first,
 * which can take a while (`preparing`, with `progress` from 0 to 1 when
 * it's known). `source` is what preparing needs from the user, such as a
 * Windows installer.
 */
export const GuestImage = z.object({
  state: z.enum(["missing", "preparing", "ready", "error"]),
  detail: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  source: z.enum(["none", "windows-iso"]),
});
export type GuestImage = z.infer<typeof GuestImage>;

export const MachineGuest = z.object({
  os: GuestOs,
  image: GuestImage,
  capabilities: MachineCapabilities,
});
export type MachineGuest = z.infer<typeof MachineGuest>;

/** A machine plugin, as the UI sees it: whether it works here, and with which guests. */
export const MachineBackend = z.object({
  id: MachineBackendId,
  name: z.string(),
  kind: z.enum(["container", "vm"]),
  available: z.boolean(),
  /** Why it isn't available, or anything worth knowing when it is. */
  detail: z.string().nullable(),
  /** Containers are the recommended way: lighter, quicker, and the most tested. */
  recommended: z.boolean(),
  guests: z.array(MachineGuest),
});
export type MachineBackend = z.infer<typeof MachineBackend>;

export const PrepareMachineImage = z.object({
  backend: MachineBackendId,
  guest: GuestOs,
  /** For a guest that needs one: a path on the host, such as a Windows ISO. */
  source: z.string().min(1).max(4096).optional(),
});
export type PrepareMachineImage = z.infer<typeof PrepareMachineImage>;
