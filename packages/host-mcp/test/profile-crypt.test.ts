import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LINUX_BASIC_KEYS,
  MAC_MOCK_KEYS,
  databaseVersions,
  outgrown,
  transcodeProfile,
  type ProfileKeys,
} from "../src/profile-crypt.ts";

const IV = Buffer.alloc(16, " ");
const seal = (text: string, key: Buffer, prefix = "v10") => {
  const c = createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([Buffer.from(prefix), c.update(text), c.final()]);
};
const open = (value: Uint8Array, keys: ProfileKeys) => {
  const d = createDecipheriv("aes-128-cbc", keys.v10!, IV);
  return Buffer.concat([d.update(Buffer.from(value).subarray(3)), d.final()]).toString();
};

/** A profile with one cookie and one saved password, as the nibblet's Chromium writes them. */
async function fakeProfile(version = 24): Promise<string> {
  const profile = join(await mkdtemp(join(tmpdir(), "crypt-")), "chromium");
  await mkdir(join(profile, "Default"), { recursive: true });
  const cookies = new DatabaseSync(join(profile, "Default", "Cookies"));
  cookies.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  cookies.exec(
    `INSERT INTO meta VALUES ('version', '${version}'), ('last_compatible_version', '${version}')`,
  );
  cookies.exec("CREATE TABLE cookies (host_key TEXT, encrypted_value BLOB)");
  cookies
    .prepare("INSERT INTO cookies VALUES (?, ?), (?, ?)")
    .run(
      "example.com",
      seal("session=1", LINUX_BASIC_KEYS.v10!),
      "old.example",
      seal("v11-cookie", LINUX_BASIC_KEYS.v11!, "v11"),
    );
  cookies.close();
  const logins = new DatabaseSync(join(profile, "Default", "Login Data"));
  logins.exec("CREATE TABLE logins (origin_url TEXT, password_value BLOB)");
  logins
    .prepare("INSERT INTO logins VALUES (?, ?)")
    .run("https://example.com", seal("hunter2", LINUX_BASIC_KEYS.v10!));
  logins.close();
  return profile;
}

const cookieValues = (profile: string) => {
  const db = new DatabaseSync(join(profile, "Default", "Cookies"));
  const rows = db.prepare("SELECT encrypted_value AS v FROM cookies ORDER BY host_key").all() as {
    v: Uint8Array;
  }[];
  db.close();
  return rows.map((r) => r.v);
};

describe("transcodeProfile", () => {
  it("re-encrypts cookies and passwords for the host browser, and back", async () => {
    const profile = await fakeProfile();
    await transcodeProfile(profile, LINUX_BASIC_KEYS, MAC_MOCK_KEYS);
    expect(cookieValues(profile).map((v) => open(v, MAC_MOCK_KEYS))).toEqual([
      "session=1",
      "v11-cookie",
    ]);
    const logins = new DatabaseSync(join(profile, "Default", "Login Data"));
    const row = logins.prepare("SELECT password_value AS v FROM logins").get() as { v: Uint8Array };
    logins.close();
    expect(open(row.v, MAC_MOCK_KEYS)).toBe("hunter2");

    await transcodeProfile(profile, MAC_MOCK_KEYS, LINUX_BASIC_KEYS);
    // Back as v10 in the nibblet's key, the v11 one included.
    expect(cookieValues(profile).map((v) => open(v, LINUX_BASIC_KEYS))).toEqual([
      "session=1",
      "v11-cookie",
    ]);
  });

  it("does nothing to a profile without databases", async () => {
    const profile = join(await mkdtemp(join(tmpdir(), "crypt-")), "chromium");
    await expect(
      transcodeProfile(profile, LINUX_BASIC_KEYS, MAC_MOCK_KEYS),
    ).resolves.toBeUndefined();
  });
});

describe("outgrown", () => {
  it("names a database the host upgraded past what the nibblet can open", async () => {
    const profile = await fakeProfile(24);
    const before = await databaseVersions(profile);
    const db = new DatabaseSync(join(profile, "Default", "Cookies"));
    db.exec("UPDATE meta SET value = '25' WHERE key IN ('version', 'last_compatible_version')");
    db.close();
    expect(outgrown(profile, before, await databaseVersions(profile))).toEqual([
      join("Default", "Cookies"),
    ]);
  });

  it("allows a newer version the nibblet can still open", async () => {
    const profile = await fakeProfile(24);
    const before = await databaseVersions(profile);
    const db = new DatabaseSync(join(profile, "Default", "Cookies"));
    db.exec("UPDATE meta SET value = '25' WHERE key = 'version'");
    db.close();
    expect(outgrown(profile, before, await databaseVersions(profile))).toEqual([]);
  });
});
