import { describe, expect, it } from "vitest";
import { compareVersions } from "./updates.ts";

describe("compareVersions", () => {
  it("compares each part as a number", () => {
    expect(compareVersions("2.1.10", "2.1.9")).toBe(1);
    expect(compareVersions("0.162.1", "0.162.1")).toBe(0);
    expect(compareVersions("1.9.0", "1.19.0")).toBe(-1);
  });

  it("ignores a leading v and anything after a dash", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });
});
