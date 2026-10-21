import { describe, expect, it } from "vitest";
import { AppleVirtualization } from "../src/index.ts";

const ctx = { dir: "/nowhere", docker: null, log: () => {} };
const job = { dir: "/nowhere", source: undefined, repo: "r/r", ref: "main", progress: () => {} };

describe("macOS guests", () => {
  it("are off unless asked for: no image is made, and no VM started", async () => {
    const apple = new AppleVirtualization({ helper: "/nowhere/nibblet-vm" });
    await expect(apple.prepareImage(ctx, "macos", job)).rejects.toThrow(/turned off/);
    await expect(
      apple.start(ctx, {
        id: "nib_1",
        dir: "/nowhere/vm",
        guest: "macos",
        cpus: 2,
        memoryMb: 4096,
        imageDir: "/nowhere/image",
        fresh: true,
      }),
    ).rejects.toThrow(/turned off/);
  });
});
