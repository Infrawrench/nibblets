import { describe, expect, it } from "vitest";
import { withVault } from "./useOnePassword.ts";

describe("withVault", () => {
  it("adds, changes and removes one vault, leaving the rest", () => {
    const start = [{ vaultId: "a", access: "read" as const }];
    expect(withVault(start, "b", "write")).toEqual([
      { vaultId: "a", access: "read" },
      { vaultId: "b", access: "write" },
    ]);
    expect(withVault(start, "a", "write")).toEqual([{ vaultId: "a", access: "write" }]);
    expect(withVault(start, "a", null)).toEqual([]);
  });
});
