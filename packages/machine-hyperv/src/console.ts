import { createWriteStream } from "node:fs";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { VmRef } from "@nibblets/machine/host";

/** Where a VM's console is recorded. */
export const consoleFile = (vm: VmRef) => join(vm.dir, "console.log");

/** How much of a console is kept: once it's twice this, it's cut back to this. */
const KEEP_BYTES = 1024 * 1024;
/** How long a VM may be off before its console stops being listened for. */
const OFF_CHECKS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Each VM's console: what its guest says on COM1, which Hyper-V serves on
 * a named pipe and keeps nothing of, recorded to its folder while it runs.
 * The pipe takes one reader at a time, and goes with each boot, so it's
 * connected to again until the VM's been off a while.
 */
export class ConsoleRecorder {
  private readonly recording = new Map<string, () => void>();
  private readonly running: (vm: VmRef) => Promise<boolean>;

  constructor(running: (vm: VmRef) => Promise<boolean>) {
    this.running = running;
  }

  /** Records `vm`'s console from `pipe`, unless it's being already. */
  record(vm: VmRef, pipe: string): void {
    if (this.recording.has(vm.id)) return;
    let stopped = false;
    let socket: Socket | null = null;
    this.recording.set(vm.id, () => {
      stopped = true;
      socket?.destroy();
    });
    void (async () => {
      const file = consoleFile(vm);
      await trim(file);
      const out = createWriteStream(file, { flags: "a" });
      out.on("error", () => {});
      for (let off = 0; !stopped && off < OFF_CHECKS;) {
        await new Promise<void>((resolve) => {
          const s = connect(pipe);
          socket = s;
          s.on("data", (chunk: Buffer) => out.write(chunk));
          s.once("error", () => {});
          s.once("close", () => resolve());
        });
        if (stopped) break;
        await sleep(2000);
        off = (await this.running(vm).catch(() => true)) ? 0 : off + 1;
      }
      out.end();
      this.recording.delete(vm.id);
    })();
  }

  /** Stops recording `id`'s console; what it said is kept. */
  stop(id: string): void {
    this.recording.get(id)?.();
    this.recording.delete(id);
  }
}

/** Cuts a console that's grown too big back to its end. */
async function trim(file: string): Promise<void> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0,
  );
  if (size <= 2 * KEEP_BYTES) return;
  const handle = await open(file, "r");
  try {
    const end = Buffer.alloc(KEEP_BYTES);
    await handle.read(end, 0, KEEP_BYTES, size - KEEP_BYTES);
    await handle.close();
    await writeFile(file, end);
  } catch {
    await handle.close().catch(() => undefined);
  }
}

/** The end of what a VM's console said, as text. */
export async function consoleTail(vm: VmRef, bytes = 16_000): Promise<string> {
  const text = await readFile(consoleFile(vm)).then(
    (b) => b.subarray(Math.max(0, b.length - bytes)).toString("utf8"),
    () => "",
  );
  // A serial line's noise: NULs, and carriage returns before each newline.
  return text.replace(/\0/g, "").replace(/\r\n/g, "\n");
}
