import { beforeEach, describe, expect, it } from "vitest";
import { hamsterNames, nextHamsterName } from "./hamsterNames.ts";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // No storage in this environment: nextHamsterName copes without it.
  }
});

describe("nextHamsterName", () => {
  it("has plenty of distinct names", () => {
    expect(new Set(hamsterNames).size).toBe(hamsterNames.length);
    expect(hamsterNames.length).toBeGreaterThanOrEqual(100);
  });

  it("skips names already in use", () => {
    const taken = hamsterNames.slice(0, hamsterNames.length - 1);
    expect(nextHamsterName(taken)).toBe(hamsterNames[hamsterNames.length - 1]);
  });

  it("numbers a name once every one is taken", () => {
    expect(nextHamsterName(hamsterNames, () => 0)).toBe("Pip 2");
  });
});
