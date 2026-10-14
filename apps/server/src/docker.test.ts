import { describe, expect, it } from "vitest";
import { limits } from "./docker.ts";

describe("limits", () => {
  it("uses the default memory and no CPU cap when nothing is set", () => {
    expect(limits({ cpus: null, memoryMb: null })).toEqual({
      Memory: 4096 * 1024 * 1024,
      MemorySwap: 4096 * 1024 * 1024,
      NanoCpus: 0,
    });
  });

  it("turns CPUs and megabytes into Docker's units", () => {
    expect(limits({ cpus: 1.5, memoryMb: 2048 })).toEqual({
      Memory: 2048 * 1024 * 1024,
      MemorySwap: 2048 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
    });
  });
});
