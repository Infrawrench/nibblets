import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearProfileLock, serveArgs } from "./computer.ts";

describe("the browser's profile lock", () => {
  let home = "";
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("is cleared when an earlier container left it behind", async () => {
    home = await mkdtemp(path.join(tmpdir(), "nibblet-guard-"));
    const profile = path.join(home, ".config", "chromium");
    await mkdir(profile, { recursive: true });
    // As Chromium leaves them: links to another host's process and a socket that's gone.
    await symlink("84ea63a80614-7", path.join(profile, "SingletonLock"));
    await symlink(
      "/tmp/org.chromium.Chromium.nhfrpC/SingletonSocket",
      path.join(profile, "SingletonSocket"),
    );
    await symlink("2932194929645123087", path.join(profile, "SingletonCookie"));
    await writeFile(path.join(profile, "Local State"), "{}");

    await clearProfileLock(home);

    expect(await readdir(profile)).toEqual(["Local State"]);
  });

  it("does nothing to a browser that has never run", async () => {
    home = await mkdtemp(path.join(tmpdir(), "nibblet-guard-"));
    await clearProfileLock(home);
    await expect(lstat(path.join(home, ".config"))).rejects.toThrow();
  });
});

describe("serve's arguments", () => {
  it("keeps MCP on loopback, and puts only the view where the server can reach it", () => {
    expect(serveArgs({ mcp: 7800, view: 7900 })).toEqual([
      "serve",
      "--port",
      "7800",
      "--listen-on",
      "127.0.0.1",
      "--view-listen",
      "0.0.0.0:7900",
    ]);
  });
});
