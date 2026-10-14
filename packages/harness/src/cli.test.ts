import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installedCli } from "./cli.ts";

describe("installedCli", () => {
  it("is null when nothing has been installed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-cli-"));
    expect(installedCli("claude", root)).toBeNull();
  });

  it("follows `current` and the .bin link to the real file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-cli-"));
    const version = path.join(root, "codex", "0.163.0", "node_modules");
    await mkdir(path.join(version, "@openai/codex/bin"), { recursive: true });
    await mkdir(path.join(version, ".bin"), { recursive: true });
    const real = path.join(version, "@openai/codex/bin/codex.js");
    await writeFile(real, "#!/usr/bin/env node\n");
    await chmod(real, 0o755);
    await symlink("../@openai/codex/bin/codex.js", path.join(version, ".bin/codex"));
    await symlink("0.163.0", path.join(root, "codex", "current"));
    expect(installedCli("codex", root)).toBe(
      await import("node:fs").then((f) => f.realpathSync(real)),
    );
  });
});
