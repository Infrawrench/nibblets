import type { Duplex } from "node:stream";
import type { EntryCommand, GuestOs } from "@nibblet/protocol";

/**
 * What the guest agent needs from the OS it's running on, one plugin per
 * guest (linux.ts, windows.ts, macos.ts): getting the machine ready before
 * anything runs, finding its port to the host, and where the nibblet's
 * entry is. Everything else (the protocol, runs, connections) is the same
 * everywhere and lives in daemon.ts.
 */
export interface GuestPlugin {
  readonly os: GuestOs;
  /**
   * Gets the machine ready before the nibblet runs: its home disk mounted
   * (made the first time), its root grown to fill its disk, its network up,
   * and `server` and `credproxy` pointed at the agent on loopback.
   */
  prepare(log: (message: string) => void): Promise<void>;
  /** The agent's serial port to the host, opened. */
  openPort(log: (message: string) => void): Promise<Duplex>;
  /** How to run the nibblet's entry with one of its commands. */
  entry(command: EntryCommand, args: readonly string[]): { file: string; argv: string[] };
  /** Shuts the machine down. */
  poweroff(): Promise<void>;
}

/** The entry's own name for a command: the nibblet itself is the default. */
export function entryArgv(command: EntryCommand, args: readonly string[]): string[] {
  return command === "main" ? [] : [command, ...args];
}
