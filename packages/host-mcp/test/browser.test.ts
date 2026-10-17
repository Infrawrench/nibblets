import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseBrowser,
  extensionIds,
  purgeProfileExtensions,
  type HostBrowser,
} from "../src/browser.ts";

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
    join(profile, "Default", "Sync Extension Settings", onePassword),
    join(profile, "Default", "IndexedDB", `chrome-extension_${onePassword}_0.indexeddb.leveldb`),
    join(profile, "Default", "IndexedDB", "https_example.com_0.indexeddb.leveldb"),
    join(profile, "Default", "Storage", "ext", onePassword),
    join(profile, "NativeMessagingHosts"),
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
    expect(await gone(join(profile, "Default", "Sync Extension Settings"))).toBe(true);
    expect(await gone(join(profile, "Default", "Storage", "ext"))).toBe(true);
    expect(await gone(join(profile, "NativeMessagingHosts"))).toBe(true);
    // An extension's IndexedDB goes; a website's stays.
    expect(await readdir(join(profile, "Default", "IndexedDB"))).toEqual([
      "https_example.com_0.indexeddb.leveldb",
    ]);
  });

  it("lists the extensions a profile has, for clearing their storage", async () => {
    const profile = await fakeProfile();
    // "someotherextension" isn't an extension id, so it's left out.
    expect(await extensionIds(profile)).toEqual(["aeblfdkhhhdcdjpifhhbdiojplfjncoa"]);
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

describe("chooseBrowser", () => {
  const chrome: HostBrowser = {
    name: "Google Chrome",
    bin: "/chrome",
    data: "/data",
    major: 155,
    loadsExtensions: false,
  };
  const chromium: HostBrowser = {
    ...chrome,
    name: "Chromium",
    bin: "/chromium",
    loadsExtensions: true,
  };

  it("picks one that can add 1Password when that's wanted", () => {
    expect(chooseBrowser([chrome, chromium], true)).toBe(chromium);
  });

  it("otherwise picks the first, and still opens without 1Password", () => {
    expect(chooseBrowser([chrome, chromium], false)).toBe(chrome);
    expect(chooseBrowser([chrome], true)).toBe(chrome);
    expect(chooseBrowser([], true)).toBeNull();
  });
});
