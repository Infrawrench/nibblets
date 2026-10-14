import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currentVersion, makeCurrent, prune } from "./harness-cli.ts";

async function release(root: string, version: string, ok = true): Promise<void> {
  await mkdir(path.join(root, "claude", version), { recursive: true });
  if (ok) await writeFile(path.join(root, "claude", version, ".ok"), "");
}

describe("harness CLI installs", () => {
  it("points current at a finished release, and only a finished one counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-cli-"));
    expect(await currentVersion(root, "claude")).toBeNull();
    await release(root, "2.1.299");
    await makeCurrent(root, "claude", "2.1.299");
    expect(await currentVersion(root, "claude")).toBe("2.1.299");
    await release(root, "2.1.300", false);
    await makeCurrent(root, "claude", "2.1.300");
    expect(await currentVersion(root, "claude")).toBeNull();
  });

  it("prunes every release but the ones kept", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-cli-"));
    for (const v of ["2.1.297", "2.1.298", "2.1.299"]) await release(root, v);
    await makeCurrent(root, "claude", "2.1.299");
    await prune(root, "claude", ["2.1.299", "2.1.298"]);
    expect((await readdir(path.join(root, "claude"))).sort()).toEqual([
      "2.1.298",
      "2.1.299",
      "current",
    ]);
  });
});
