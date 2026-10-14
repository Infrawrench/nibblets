import { describe, expect, it } from "vitest";
import { mergePaths, parseShellPath, shellPath } from "./shell-path.ts";

describe("shell PATH", () => {
  it("reads the PATH between the markers, whatever else the shell printed", () => {
    const out =
      "Welcome back!\n__NIBBLETS_PATH__/a/bin:/b/bin__NIBBLETS_PATH__\n[oh-my-zsh] up to date";
    expect(parseShellPath(out)).toBe("/a/bin:/b/bin");
    expect(parseShellPath("no markers here")).toBeNull();
  });

  it("merges lists, keeping the first of each and dropping blanks", () => {
    expect(mergePaths("/a:/b", "", "/b:/c::/a")).toBe("/a:/b:/c");
  });

  it.skipIf(process.platform === "win32")("gets a PATH from a real shell", async () => {
    const path = await shellPath("/bin/sh");
    expect(path).toContain("/bin");
  });
});
