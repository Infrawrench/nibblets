import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Run } from "../src/clis/cli.ts";
import { detectOpencode, opencodePaths, readOpencodeLogin } from "../src/opencode.ts";

let home: string;
const noCli: Run = async () => ({ code: 127, stdout: "", stderr: "" });

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "oc-host-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode on the host", () => {
  it("isn't installed with no CLI, app or login", async () => {
    const paths = opencodePaths({}, home);
    expect(await detectOpencode(noCli, paths, [])).toMatchObject({
      installed: false,
      hasLogin: false,
    });
  });

  it("counts a login as installed even without the CLI, and reads it", async () => {
    const paths = opencodePaths({}, home);
    await mkdir(path.dirname(paths.auth), { recursive: true });
    await writeFile(paths.auth, '{"neon":{"type":"api","key":"secret"}}');
    await mkdir(path.dirname(paths.configs[0] ?? ""), { recursive: true });
    await writeFile(paths.configs[1] ?? "", '{"model":"neon/x"}');
    expect(await detectOpencode(noCli, paths, [])).toMatchObject({
      installed: true,
      hasLogin: true,
      version: null,
    });
    expect(await readOpencodeLogin(paths)).toEqual({
      config: '{"model":"neon/x"}',
      auth: '{"neon":{"type":"api","key":"secret"}}',
    });
  });

  it("reports the CLI's version when it's on PATH", async () => {
    const cli: Run = async () => ({ code: 0, stdout: "1.19.0\n", stderr: "" });
    expect((await detectOpencode(cli, opencodePaths({}, home), [])).version).toBe("1.19.0");
  });
});
