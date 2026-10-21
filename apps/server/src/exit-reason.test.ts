import { describe, expect, it } from "vitest";
import { exitReason } from "./conductor.ts";

describe("why a runner stopped", () => {
  it("is Node's error, which comes before its last lines", () => {
    const logs = [
      "runner: starting",
      "file:///app/apps/runner/src/main.ts:41",
      "    throw new Error(`no ${what}`);",
      "    ^",
      "",
      "Error: spawn python3 ENOENT",
      "    at ChildProcess._handle.onexit (node:internal/child_process:285:19)",
      "",
      "Node.js v24.22.0",
      "entry: the runner stopped (1)",
      "entry: the guard stopped (null)",
    ].join("\n");
    expect(exitReason(logs)).toBe(
      "Error: spawn python3 ENOENT Node.js v24.22.0 entry: the runner stopped (1) entry: the guard stopped (null)",
    );
  });

  it("is its last lines when there's no error to show", () => {
    expect(exitReason("one\ntwo\nthree\nfour\n")).toBe("two three four");
  });
});
