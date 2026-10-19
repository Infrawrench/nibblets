import { describe, expect, it } from "vitest";
import { wslPath } from "./stack.ts";

describe("a folder, as Docker in WSL sees it", () => {
  it("is under /mnt, by its drive's letter", () => {
    expect(wslPath("D:\\a\\nibblets\\test\\integration\\")).toBe(
      "/mnt/d/a/nibblets/test/integration/",
    );
    expect(wslPath("C:/Users/runner")).toBe("/mnt/c/Users/runner");
  });

  it("is as it was when it's already a POSIX path", () => {
    expect(wslPath("/home/runner/work")).toBe("/home/runner/work");
  });
});
