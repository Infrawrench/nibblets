import { describe, expect, it } from "vitest";
import { limits, parseDockerEvent } from "../src/index.ts";

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

describe("parseDockerEvent", () => {
  it("reads the nibblet, the container, and the exit code from a die event", () => {
    const line = JSON.stringify({
      status: "die",
      id: "abc123",
      Actor: { ID: "abc123", Attributes: { "nibblet.id": "nib_1", exitCode: "137" } },
    });
    expect(parseDockerEvent(line)).toEqual({
      nibbletId: "nib_1",
      containerId: "abc123",
      exitCode: 137,
    });
  });

  it("ignores lines that aren't JSON", () => {
    expect(parseDockerEvent("not json")).toBeNull();
  });
});
