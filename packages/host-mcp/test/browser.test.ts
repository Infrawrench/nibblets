import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeProfileExtensions } from "../src/browser.ts";

const gone = (path: string) =>
  access(path, constants.F_OK).then(
    () => false,
    () => true,
  );

/** Lays out a Chrome profile with a 1Password extension and its state. */
async function fakeProfile(): Promise<string> {
  const profile = join(await mkdtemp(join(tmpdir(), "profile-")), "chromium");
  const onePassword = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  for (const dir of [
    join(profile, "Default", "Extensions", onePassword, "2.0.1_0"),
    join(profile, "Default", "Local Extension Settings", onePassword),
    join(profile, "Default", "Extension State"),
    join(profile, "Profile 1", "Extensions", "someotherextension"),
  ]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "file"), "x");
  }
  await writeFile(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { settings: { [onePassword]: { state: 1 } } }, other: true }),
  );
  await writeFile(join(profile, "Default", "Cookies"), "keep-me");
  return profile;
}

describe("purgeProfileExtensions", () => {
  it("removes every extension and its state from every profile", async () => {
    const profile = await fakeProfile();
    await purgeProfileExtensions(profile);

    const op = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
    expect(await gone(join(profile, "Default", "Extensions", op))).toBe(true);
    expect(await gone(join(profile, "Default", "Local Extension Settings"))).toBe(true);
    expect(await gone(join(profile, "Default", "Extension State"))).toBe(true);
    expect(await gone(join(profile, "Profile 1", "Extensions"))).toBe(true);
  });

  it("drops the extensions block from Preferences but keeps the rest of the profile", async () => {
    const profile = await fakeProfile();
    await purgeProfileExtensions(profile);

    const prefs = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(join(profile, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.extensions).toBeUndefined();
    expect(prefs.other).toBe(true);
    // Sign-in state (cookies) is what the borrow is for, so it must survive.
    expect(await readdir(join(profile, "Default"))).toContain("Cookies");
  });

  it("does nothing for a profile that isn't there", async () => {
    await expect(
      purgeProfileExtensions(join(tmpdir(), "nope-", String(Math.random()))),
    ).resolves.toBeUndefined();
  });
});
