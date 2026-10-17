import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
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

/**
 * A relay's stdio as one stream: what it prints comes in, what's written
 * goes to it. For a port that only a helper can open (vsock on macOS, a
 * COM port on Windows).
 */
export function relayStream(file: string, args: string[]): Duplex {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk: Buffer, _enc, done) {
      if (child.stdin.write(chunk)) done();
      else child.stdin.once("drain", () => done());
    },
    final(done) {
      child.stdin.end();
      done();
    },
    destroy(err, done) {
      if (child.exitCode === null) child.kill();
      done(err);
    },
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) child.stdout.pause();
  });
  child.stdout.once("end", () => stream.push(null));
  child.stdin.on("error", () => {});
  child.once("error", (err) => stream.destroy(err));
  child.once("exit", () => stream.destroy());
  return stream;
}
