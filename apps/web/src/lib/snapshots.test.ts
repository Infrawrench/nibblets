import { describe, expect, it } from "vitest";
import { formatBytes, frequencyOptions } from "./snapshots.ts";

describe("snapshot helpers", () => {
  it("formats sizes compactly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(48 * 1024 * 1024)).toBe("48 MB");
    expect(formatBytes(3.25 * 1024 ** 3)).toBe("3.3 GB");
  });

  it("keeps an unusual frequency visible", () => {
    expect(frequencyOptions({ everyMinutes: 1440, keep: 7 })).toHaveLength(5);
    expect(frequencyOptions({ everyMinutes: 120, keep: 7 }).at(-1)).toEqual({
      value: "120",
      label: "Every 2 hours",
    });
  });
});
