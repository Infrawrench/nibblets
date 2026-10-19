/**
 * The guest agent: the daemon a nibblet's virtual machine starts at boot,
 * as root (SYSTEM on Windows), on the virtual serial port the hypervisor
 * gave it. It gets the machine ready, then does for the server what
 * `docker exec` does for a container. See daemon.ts, and protocol's guest.ts
 * for what goes over the port.
 */
import { readFileSync } from "node:fs";
import type { Writable } from "node:stream";
import { z } from "zod";
import { GuestDaemon } from "./daemon.ts";
import type { GuestPlugin } from "./guest.ts";
import { linux } from "./linux.ts";
import { macos } from "./macos.ts";
import { windows } from "./windows.ts";

const guests: Partial<Record<NodeJS.Platform, GuestPlugin>> = {
  linux,
  darwin: macos,
  win32: windows,
};

const VERSION = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")),
  ).version;

/** The guest's console, where it keeps one; lines are dropped rather than kept while it's behind. */
let consoleOut: Writable | null = null;
const log = (message: string) => {
  const line = `agent: ${message}`;
  console.log(line);
  if (consoleOut && consoleOut.writableLength < 64_000) consoleOut.write(`${line}\r\n`);
};

async function main(): Promise<void> {
  const guest = guests[process.platform];
  if (!guest) throw new Error(`no guest plugin for ${process.platform}`);
  consoleOut = guest.console?.() ?? null;
  try {
    await guest.prepare(log);
  } catch (err) {
    // Said, and carried on: the server can still reach it, and its logs say why.
    log(`getting ready failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const daemon = new GuestDaemon({
    guest,
    version: VERSION,
    listen: {
      server: { host: "127.0.0.1", port: 8420 },
      credproxy: { host: "127.0.0.1", port: 8787 },
    },
    log,
  });
  await daemon.listen();
  const port = await guest.openPort(log);
  daemon.attach(port);
  port.once("close", () => {
    log("lost the port to the host");
    process.exit(1);
  });
  log(`ready, on ${guest.os}`);
}

main().catch((err: unknown) => {
  console.error(`agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
