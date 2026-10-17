import { z } from "zod";
import { GuestImage, GuestOs } from "@nibblet/protocol";

/**
 * The host bridge's `/machines` API: how the server, in a container, has
 * the host's hypervisors make and run virtual machines. Every route takes
 * the bridge's token.
 *
 *   GET    /machines                          HostMachines
 *   POST   /machines/:hv/images/:guest        PrepareImage → 202
 *   GET    /machines/:hv/vms                  VmInfo[]
 *   PUT    /machines/:hv/vms/:id              StartVm → VmInfo (boots it)
 *   POST   /machines/:hv/vms/:id/stop         StopVm → VmInfo
 *   PATCH  /machines/:hv/vms/:id              UpdateVm → VmInfo (applies on its next start)
 *   DELETE /machines/:hv/vms/:id              removes it, disks and all
 *   GET    /machines/:hv/vms/:id/console      Console
 *   GET    /machines/:hv/vms/:id/link         WebSocket: its guest agent (see guest.ts in protocol)
 *   GET    /machines/:hv/capacity             Capacity
 */

export const HostImage = GuestImage.extend({
  /**
   * What it was made from, so the server can tell when it's out of date:
   * the runner image's id for Linux, the Nibblets release for the rest.
   */
  builtFrom: z.string().nullable(),
});
export type HostImage = z.infer<typeof HostImage>;

export const HypervisorInfo = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  detail: z.string().nullable(),
  guests: z.array(z.object({ os: GuestOs, image: HostImage })),
});
export type HypervisorInfo = z.infer<typeof HypervisorInfo>;

export const HostMachines = z.object({ hypervisors: z.array(HypervisorInfo) });
export type HostMachines = z.infer<typeof HostMachines>;

export const PrepareImage = z.object({
  /** A path on the host, for a guest whose image needs one (a Windows ISO). */
  source: z.string().optional(),
  /** For Linux: the runner image to make it from, on the host's Docker engine. */
  runnerImage: z.string().optional(),
  /** For the rest: the Nibblets release the server runs, whose runner they install. */
  version: z.string().optional(),
  /** And the GitHub repository its releases come from, as `owner/repo`. */
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  /** The git ref (tag, branch or commit) of `repo` to install, if not the release's tag. */
  ref: z
    .string()
    .regex(/^[\w./-]+$/)
    .max(200)
    .optional(),
});
export type PrepareImage = z.infer<typeof PrepareImage>;

export const VmSize = z.object({
  cpus: z.int().min(1).max(256),
  memoryMb: z.int().min(512),
});
export type VmSize = z.infer<typeof VmSize>;

export const StartVm = VmSize.extend({
  guest: GuestOs,
  /** Make its system disk afresh from the current image (its home disk stays). */
  fresh: z.boolean(),
  /** It's joining a tailnet, so it'll have Tailscale state to sign out later. */
  tailscale: z.boolean(),
});
export type StartVm = z.infer<typeof StartVm>;

export const UpdateVm = VmSize.partial().extend({
  /** False once it's signed out of the tailnet. */
  tailscale: z.boolean().optional(),
});
export type UpdateVm = z.infer<typeof UpdateVm>;

export const StopVm = z.object({
  /** Pull the plug, rather than asking the guest to shut down. */
  force: z.boolean(),
});

export const VmInfo = z.object({
  /** The nibblet's id. */
  id: z.string(),
  guest: GuestOs,
  running: z.boolean(),
  /** Made afresh each time it starts, so a link can tell which boot it's on. */
  boot: z.string().nullable(),
  /** What its system disk was made from: the image's `builtFrom` then. */
  image: z.string().nullable(),
  /** It may still be signed in to a tailnet. */
  tailscale: z.boolean(),
});
export type VmInfo = z.infer<typeof VmInfo>;

export const Console = z.object({ text: z.string() });

export const Capacity = z.object({ cpus: z.int(), memoryMb: z.int() }).nullable();
export type Capacity = z.infer<typeof Capacity>;
