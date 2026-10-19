import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleRecorder, consoleTail } from "../src/console.ts";

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("a VM's console", () => {
  let dir = "";
  let server: Server | null = null;
  const recorder = new ConsoleRecorder(async () => true);
  afterEach(async () => {
    recorder.stop("nib_1");
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // A socket stands in for Hyper-V's pipe: Node connects to either the same way.
  it("is what the guest said on it, kept through the guest going and coming back", async () => {
    dir = await mkdtemp(join(tmpdir(), "nibblet-console-"));
    const pipe = join(dir, "console.sock");
    const guests: Socket[] = [];
    server = createServer((socket) => guests.push(socket));
    await new Promise<void>((resolve) => server?.listen(pipe, resolve));
    const vm = { id: "nib_1", dir };

    recorder.record(vm, pipe);
    // Asked again, as the bridge does on each connect: still the one recording.
    recorder.record(vm, pipe);
    await until(async () => guests.length === 1);
    guests[0]?.write("agent: ready, on windows\r\n\0");
    await until(async () => (await consoleTail(vm)).includes("ready"));
    // A reboot: the pipe goes, and comes back.
    guests[0]?.destroy();
    await until(async () => guests.length === 2);
    guests[1]?.write("agent: ready again\r\n");
    await until(async () => (await consoleTail(vm)).includes("again"));

    expect(await consoleTail(vm)).toBe("agent: ready, on windows\nagent: ready again\n");
  });
});
