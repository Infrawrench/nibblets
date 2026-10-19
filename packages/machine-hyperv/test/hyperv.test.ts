import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HyperV } from "../src/index.ts";
import { encodeCommand, type PowerShell } from "../src/powershell.ts";

/** A PowerShell that answers from a list, keeping what it was asked. */
function fake(answers: object[]): { ps: PowerShell; calls: { script: string; params: object }[] } {
  const calls: { script: string; params: object }[] = [];
  return {
    calls,
    ps: async (script, params) => {
      calls.push({ script, params });
      return `${JSON.stringify(answers.shift() ?? { ok: true })}\n`;
    },
  };
}

const ctx = { dir: "C:\\machines\\hyperv", docker: null, log: () => {} };

describe("Hyper-V", () => {
  it("encodes scripts as PowerShell's -EncodedCommand wants them", () => {
    expect(Buffer.from(encodeCommand("Get-VM"), "base64").toString("utf16le")).toBe("Get-VM");
  });

  it("says why when it can't run VMs", async () => {
    const { ps } = fake([{ ok: false, detail: "Hyper-V isn't turned on" }]);
    const found = await new HyperV({ powershell: ps }).detect(ctx);
    if (process.platform === "win32") {
      expect(found).toEqual({ available: false, detail: "Hyper-V isn't turned on", guests: [] });
    } else {
      expect(found.available).toBe(false);
    }
  });

  it("never puts a value in a script: they go as parameters", async () => {
    const { ps, calls } = fake([
      { "nibblet-nib_x'; Remove-Item C:\\ -Recurse #": "Running" },
      { ok: true },
    ]);
    const hyperv = new HyperV({ powershell: ps });
    const vm = { id: "nib_x'; Remove-Item C:\\ -Recurse #", dir: "C:\\vms\\x" };
    expect(await hyperv.running(ctx, vm)).toBe(true);
    await hyperv.stop(ctx, vm, true);
    for (const call of calls) expect(call.script).not.toContain("nib_x");
    expect(calls[1]?.params).toEqual({ name: `nibblet-${vm.id}`, force: true });
  });

  it("names a VM's agent port as a pipe of its own, and its disks in its folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hyperv-"));
    // A VM made before: it boots from the disks it has.
    await writeFile(join(dir, "system.vhdx"), "");
    const { ps, calls } = fake([{ ok: true }]);
    await new HyperV({ powershell: ps }).start(ctx, {
      id: "nib_a",
      dir,
      guest: "linux",
      cpus: 2,
      memoryMb: 2048,
      imageDir: "/no-image",
      fresh: false,
    });
    expect(calls[0]?.params).toMatchObject({
      name: "nibblet-nib_a",
      agent: "\\\\.\\pipe\\nibblet-nib_a-agent",
      switch: "Default Switch",
      system: join(dir, "system.vhdx"),
      home: join(dir, "home.vhdx"),
      fresh: false,
      guest: "linux",
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("goes out through the switch it's given, where there's no Default Switch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hyperv-"));
    await writeFile(join(dir, "system.vhdx"), "");
    const { ps, calls } = fake([{ ok: true }]);
    await new HyperV({ powershell: ps, switch: "nibblets" }).start(ctx, {
      id: "nib_b",
      dir,
      guest: "linux",
      cpus: 2,
      memoryMb: 2048,
      imageDir: "/no-image",
      fresh: false,
    });
    expect(calls[0]?.params).toMatchObject({ switch: "nibblets" });
    await rm(dir, { recursive: true, force: true });
  });

  it("asks about its own switch whenever it looks at the host", async () => {
    const { ps, calls } = fake([{ ok: true, cpus: 4, memoryMb: 16384 }]);
    expect(await new HyperV({ powershell: ps, switch: "nibblets" }).capacity()).toEqual({
      cpus: 4,
      memoryMb: 16384,
    });
    expect(calls[0]?.params).toEqual({ switch: "nibblets" });
  });
});
