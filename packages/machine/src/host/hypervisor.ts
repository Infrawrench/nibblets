import type { Duplex } from "node:stream";
import type { GuestImage, GuestOs } from "@nibblet/protocol";
import type { Capacity } from "../bridge-api.ts";

/**
 * The contract a hypervisor plugin fulfils on the host (`machine-apple`,
 * `machine-hyperv`): turning VMs on and off and handing over the host's
 * end of each one's agent port. The host bridge loads them with
 * `HostMachines`, which does the rest the same way for all of them:
 * keeping track of VMs and their boots, making images (Linux's from the
 * runner image, shared), and relaying each agent's port to the server.
 *
 * Each VM has a folder of its own (`VmRef.dir`) for its disks and whatever
 * else the hypervisor keeps, and each image one per version (`imageDir`),
 * kept while a VM was made from it.
 */
export interface HypervisorPlugin {
  readonly id: string;
  readonly name: string;
  /** The format its disks are in, which Linux images are made in for it. */
  readonly diskFormat: "raw" | "vhdx";

  /** Whether it works here, and which guests it can run. */
  detect(
    ctx: HostContext,
  ): Promise<{ available: boolean; detail: string | null; guests: GuestOs[] }>;

  /** What making a guest's image needs from the user. */
  imageSource(guest: GuestOs): GuestImage["source"];
  /**
   * Makes the image a guest's VMs start from, other than Linux's (made for
   * it), in `job.dir`. `progress` takes a fraction when it knows one.
   */
  prepareImage(ctx: HostContext, guest: GuestOs, job: ImageJob): Promise<void>;

  /**
   * Boots a VM. A new one, or one with `fresh`, gets a system disk made
   * from the image in `imageDir` (its home disk, made empty the first time,
   * is kept); otherwise it boots from the disks it has.
   */
  start(ctx: HostContext, vm: VmSpec): Promise<void>;
  /** Asks the guest to shut down, or with `force` turns it off. */
  stop(ctx: HostContext, vm: VmRef, force: boolean): Promise<void>;
  running(ctx: HostContext, vm: VmRef): Promise<boolean>;
  /** Takes it off the hypervisor. Its folder is deleted for it afterwards. */
  remove(ctx: HostContext, vm: VmRef): Promise<void>;
  /** The host's end of its agent's serial port, while it runs. */
  connect(ctx: HostContext, vm: VmRef): Promise<Duplex>;
  /** The end of its console, for saying why it stopped. */
  console(ctx: HostContext, vm: VmRef): Promise<string>;
  capacity(ctx: HostContext): Promise<Capacity>;
}

export interface HostContext {
  /** Where this hypervisor keeps its images and VMs. */
  dir: string;
  /** The Docker CLI, which makes Linux images from the runner image. */
  docker: string | null;
  log(message: string): void;
}

export interface ImageJob {
  dir: string;
  /** A path on the host the user gave, for an image that needs one. */
  source: string | undefined;
  /** The Nibblets release the server runs, for guests that install the runner themselves. */
  version: string;
  progress(fraction: number | null, detail: string | null): void;
}

export interface VmRef {
  /** The nibblet's id. */
  id: string;
  dir: string;
}

export interface VmSpec extends VmRef {
  guest: GuestOs;
  cpus: number;
  memoryMb: number;
  imageDir: string;
  fresh: boolean;
}
