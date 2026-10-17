import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

/** What hypervisor plugins share: small things every one of them needs. */

/** A locally administered, unicast MAC address, for a VM to keep. */
export function randomMac(): string {
  const b = randomBytes(6);
  b[0] = ((b[0] ?? 0) & 0xfc) | 0x02;
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join(":");
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid from a pid file, if it's still running. */
export async function livePid(file: string): Promise<number | null> {
  const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
  return pid > 0 && alive(pid) ? pid : null;
}

/**
 * A unix socket's path for a VM. Paths are short on macOS (104 bytes) and
 * Linux (108), and a VM's folder can be deep, so they go in the temporary folder.
 */
export function socketPath(hypervisor: string, id: string, what: string): string {
  return join(tmpdir(), `nibblet-${hypervisor}-${id}-${what}.sock`);
}

/** A connection to a local socket or named pipe, once it's open. */
export function connectTo(path: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** The end of a text file, for a console. */
export async function tailFile(path: string, chars = 16_000): Promise<string> {
  return (await readFile(path, "utf8").catch(() => "")).slice(-chars);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
