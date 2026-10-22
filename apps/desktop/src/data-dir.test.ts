import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "./data-dir.ts";

const APP_DATA = "/Users/someone/Library/Application Support";

describe("dataDir", () => {
  it("keeps an install from before the rename in its own folder", () => {
    const old = join(APP_DATA, "@nibblet", "desktop");
    expect(dataDir(APP_DATA, (p) => p === join(old, "settings.json"))).toBe(old);
  });

  it("uses the renamed folder for a new install", () => {
    expect(dataDir(APP_DATA, () => false)).toBe(join(APP_DATA, "@nibblets", "desktop"));
  });
});
