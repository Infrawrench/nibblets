import type { Readable, Writable } from "node:stream";
import type {
  GuestOs,
  MachineBackend,
  MachineCapabilities,
  MachineChoice,
  Resources,
} from "@nibblet/protocol";

/**
 * The contract every machine plugin fulfils: how the server's conductor
 * starts, stops, reaches into and tidies up the machine a nibblet runs in,
 * whatever that machine is. `@nibblet/machine-docker` makes containers;
 * the virtual machine plugins (`createVmPlugin`, one per hypervisor) make
 * VMs on the host through its bridge.
 *
 * A nibblet's machine is named by the nibblet's id. Sub-agents run inside
 * their host's machine (the top of their tree's), so the sub-agent methods
 * take the host's id and their own.
 */
export interface MachinePlugin {
  /** Stored with each nibblet (`MachineChoice.backend`), so never changes. */
  readonly id: string;
  readonly name: string;
  readonly kind: "container" | "vm";

  /**
   * Whether it works here, and how each guest's image stands; null when
   * it isn't here at all (a hypervisor for another OS than the host's).
   */
  describe(): Promise<MachineBackend | null>;
  /** What a machine running `guest` can do. */
  capabilities(guest: GuestOs): MachineCapabilities;
  /** Makes the image a guest's machines start from; `source` when it needs one from the user. */
  prepare(guest: GuestOs, source: string | undefined): Promise<void>;

  /** Every machine it has for a nibblet, running or not, by nibblet id. */
  machines(): Promise<Map<string, MachineState>>;
  /**
   * Calls back whenever a nibblet's machine stops without being asked to.
   * Machines this plugin stopped or replaced itself aren't reported.
   */
  watchExits(listener: ExitListener): Promise<void>;

  /** Starts a nibblet's machine afresh, replacing one that's there; returns its id. */
  start(nibbletId: string, spec: MachineSpec): Promise<string>;
  running(nibbletId: string): Promise<boolean>;
  /** Made from an older image than the current one, so missing fixes until it's started again. */
  outdated(nibbletId: string): Promise<boolean>;
  /** Stops it, giving what runs inside the time to finish. Its home stays. */
  stop(nibbletId: string): Promise<void>;
  /** Gets rid of a machine left behind, at once. Its home stays. */
  discard(nibbletId: string): Promise<void>;
  /** Deletes its home and anything else it kept; only for when the nibblet is deleted. */
  removeHome(nibbletId: string): Promise<void>;
  /** The end of what its entry printed, for saying why it stopped. */
  logs(nibbletId: string, tail: number): Promise<string>;
  /** Where the server reaches a port inside it, as `host:port`; null when it isn't up. */
  address(nibbletId: string, port: number): Promise<string | null>;

  startSubagent(
    hostId: string,
    nibbletId: string,
    env: MachineEnv,
    onExit: SubagentExit,
  ): Promise<void>;
  stopSubagent(hostId: string, nibbletId: string): Promise<void>;
  /** Deletes what a sub-agent kept in its host's home: its harness's state and its browser. */
  removeSubagentState(hostId: string, nibbletId: string): Promise<void>;

  /** Writes its home folder to `out` as a gzipped tar, leaving caches out. */
  archiveHome(nibbletId: string, out: Writable): Promise<void>;
  /** Replaces its home folder with one from `archiveHome`. It must be stopped. */
  restoreHome(nibbletId: string, archive: Readable): Promise<void>;

  /** New limits: applied at once where `capabilities().liveResources`, otherwise on its next start. */
  applyResources(nibbletId: string, resources: Resources): Promise<void>;
  /** The CPUs and memory it can hand out, for sizing limits in the UI. */
  capacity(): Promise<{ cpus: number; memoryMb: number } | null>;
  /** Signs out the machine a sleeping nibblet left on the tailnet. */
  leaveTailnet(nibbletId: string): Promise<void>;
  /**
   * For a running Windows guest: installs a product key and activates it,
   * unless it's activated with that key already, saying which. Only plugins
   * that run Windows have it.
   */
  activateWindows?(nibbletId: string, productKey: string): Promise<"activated" | "already">;
}

/** Everything a runner and its guard start with (`RunnerEnv & GuardEnv`). */
export type MachineEnv = Readonly<Record<string, string>>;

export interface MachineSpec {
  machine: MachineChoice;
  env: MachineEnv;
  resources: Resources;
  /** Share the host's SSH agent, where the plugin can. */
  sshAgent: boolean;
  /** It's on the tailnet: Tailscale's state is kept apart from its home. */
  tailscale: boolean;
  /** What's taking the time while it starts, such as making an image first. */
  progress: (detail: string) => void;
}

export interface MachineState {
  /** The plugin's own id for it: a container id, or a VM's. */
  id: string;
  running: boolean;
}

export type ExitListener = (nibbletId: string, code: number | null) => void;
export type SubagentExit = (code: number | null, tail: string) => void;

/** What every plugin runs in its machine for a sub-agent: the entry's own command. */
export const SUBAGENT_COMMAND = "subagent";
/** And to sign out a machine left on the tailnet. */
export const TAILSCALE_LEAVE_COMMAND = "tailscale-leave";

/** Ids are the server's own (`nb_` and base64url), but they end up in paths and scripts. */
export function safeId(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`not a nibblet id: ${id}`);
  return id;
}
