import type { ChildProcess } from "node:child_process";

/** Who a process runs as: the guard, which holds the secrets, or the agent (and the runner). */
export type Who = "guard" | "agent";

/**
 * What the nibblet's entry needs from the OS it's on, one plugin per OS
 * (linux.ts in containers and Linux VMs, macos.ts and windows.ts in those
 * VMs): the firewall, the users and their folders, and starting a process
 * as one of them. entry.ts does the rest the same way everywhere: the
 * guard and the runner, sub-agents, and the jobs the server runs.
 */
export interface EntryPlatform {
  /** The agent's home, which holds its work folder, the guard's home and everyone's state. */
  readonly home: string;
  /** Where each running sub-agent's entry leaves its pid, out of the agent's reach. */
  readonly pids: string;
  /** The environment the guard is given from the entry's own, besides its secrets. */
  readonly guardEnv: readonly string[];

  /**
   * Gets the machine ready before the pair starts: the firewall, the users
   * and their folders, and anything else of the OS's own (Tailscale, on
   * Linux). Returns what to do once the pair has stopped.
   */
  prepare(log: (message: string) => void): Promise<() => Promise<void>>;
  /** A folder of `who`'s alone (`mode` on POSIX), made if it isn't there. */
  ownedDir(dir: string, who: Who, mode: number): Promise<void>;
  /** A link at `at` to the folder `to`. */
  link(to: string, at: string): Promise<void>;
  /** A sub-agent's own temporary folder, for logins and task logs. */
  tmpDir(id: string): string;
  /** The guard's runtime folder, where it has one (its display's, on Linux). */
  runtimeDir(id: string | null): string | null;

  /** Starts one of the runner's scripts as `who`, with exactly `env`; `group` so what it starts goes with it. */
  spawn(
    who: Who,
    script: string,
    env: Record<string, string>,
    opts: { group: boolean },
  ): ChildProcess;
  /** Kills a process and whatever it started. */
  killTree(child: ChildProcess): void;
  /** Asks a process to stop, then makes it, after `graceMs`. */
  terminate(pid: number, graceMs: number): Promise<void>;

  /** The home folder as a gzipped tar on stdout, without its caches. */
  archiveHome(): Promise<void>;
  /** Empties the home folder and unpacks one from stdin over it. */
  restoreHome(): Promise<void>;
  /**
   * How OpenComputerUse is started where it has to be put in the signed-in
   * session (Windows): this command, with these arguments before its own.
   * The entry then starts the desktop itself, for the runner to join.
   */
  readonly ocu?: { command: string; args: readonly string[] };
  /** Signs out of the tailnet, where the platform has Tailscale. */
  leaveTailnet?(): Promise<void>;
  /**
   * Installs a product key and activates it, unless it's activated with that
   * key already, where the platform is Windows.
   */
  activateWindows?(productKey: string): Promise<"activated" | "already">;
}
