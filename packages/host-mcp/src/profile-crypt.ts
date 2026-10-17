import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Chromium encrypts cookies and saved passwords with a key that depends on
 * where it runs. The nibblet's Chromium has no keyring, so it uses Linux's
 * fixed key. Chrome on a Mac uses one from the Keychain unless it's started
 * with `--use-mock-keychain`, which swaps in another fixed one. Neither can
 * read the other's, so a borrowed profile has its secrets re-encrypted on
 * the way in and again on the way back.
 */

/** A key for each version prefix Chromium writes (`v10`, `v11`). */
export type ProfileKeys = Partial<Record<"v10" | "v11", Buffer>>;

const derive = (password: string, iterations: number): Buffer =>
  pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");

/** The nibblet's Chromium: Linux with no keyring (v11 falls back to an empty password). */
export const LINUX_BASIC_KEYS: ProfileKeys = { v10: derive("peanuts", 1), v11: derive("", 1) };
/** Chrome on a Mac started with `--use-mock-keychain`. */
export const MAC_MOCK_KEYS: ProfileKeys = { v10: derive("mock_password", 1003) };

/** The flag that makes a host browser use the keys `hostProfileKeys` returns. */
export function hostKeyFlag(platform = process.platform): string {
  return platform === "darwin" ? "--use-mock-keychain" : "--password-store=basic";
}

export function hostProfileKeys(platform = process.platform): ProfileKeys {
  return platform === "darwin" ? MAC_MOCK_KEYS : LINUX_BASIC_KEYS;
}

const IV = Buffer.alloc(16, " ");

function decrypt(value: Buffer, keys: ProfileKeys): Buffer | null {
  const prefix = value.subarray(0, 3).toString("latin1");
  const key = prefix === "v10" || prefix === "v11" ? keys[prefix] : undefined;
  if (!key) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
}

function encrypt(plain: Buffer, keys: ProfileKeys): Buffer {
  const cipher = createCipheriv("aes-128-cbc", keys.v10!, IV);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

/** Each database holding encrypted values, with the table and column they're in. */
const ENCRYPTED = [
  { file: "Cookies", table: "cookies", column: "encrypted_value" },
  { file: join("Network", "Cookies"), table: "cookies", column: "encrypted_value" },
  { file: "Login Data", table: "logins", column: "password_value" },
  { file: "Login Data For Account", table: "logins", column: "password_value" },
];

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** Every encrypted database in every browser profile (Default, Profile 1, …). */
async function encryptedDatabases(
  profile: string,
): Promise<{ path: string; table: string; column: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(profile);
  } catch {
    return [];
  }
  const found: { path: string; table: string; column: string }[] = [];
  for (const dir of entries) {
    for (const db of ENCRYPTED) {
      const path = join(profile, dir, db.file);
      if (await isFile(path)) found.push({ ...db, path });
    }
  }
  return found;
}

function open(path: string): DatabaseSync | null {
  try {
    return new DatabaseSync(path);
  } catch {
    return null;
  }
}

/**
 * Re-encrypts every cookie and saved password in the profile from `from`'s
 * keys to `to`'s. Values it can't decrypt are left as they are; the browser
 * that reads them drops them, as it would have anyway.
 */
export async function transcodeProfile(
  profile: string,
  from: ProfileKeys,
  to: ProfileKeys,
): Promise<void> {
  for (const { path, table, column } of await encryptedDatabases(profile)) {
    const db = open(path);
    if (!db) continue;
    try {
      const rows = db.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table}`).all() as {
        id: number;
        value: Uint8Array | null;
      }[];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      db.exec("BEGIN");
      for (const row of rows) {
        if (!row.value || row.value.length < 3) continue;
        const plain = decrypt(Buffer.from(row.value), from);
        if (plain) update.run(encrypt(plain, to), row.id);
      }
      db.exec("COMMIT");
    } catch {
      // Not the table we expected (some other Chromium's layout): leave it alone.
    } finally {
      db.close();
    }
  }
}

/** Each encrypted database's schema version and the oldest version that can still open it. */
export async function databaseVersions(
  profile: string,
): Promise<Map<string, { version: number; compatible: number }>> {
  const versions = new Map<string, { version: number; compatible: number }>();
  for (const { path } of await encryptedDatabases(profile)) {
    const db = open(path);
    if (!db) continue;
    try {
      const meta = new Map(
        (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
          (r) => [r.key, Number(r.value)],
        ),
      );
      const version = meta.get("version");
      if (version === undefined) continue;
      versions.set(path, {
        version,
        compatible: meta.get("last_compatible_version") ?? meta.get("compatible_version") ?? 0,
      });
    } catch {
      // No meta table: nothing to compare.
    } finally {
      db.close();
    }
  }
  return versions;
}

/**
 * The databases the host browser upgraded past what the nibblet's Chromium
 * can open: one it last wrote at version N can't read one that needs more
 * than N. Relative paths, for a message.
 */
export function outgrown(
  profile: string,
  before: Map<string, { version: number; compatible: number }>,
  after: Map<string, { version: number; compatible: number }>,
): string[] {
  const out: string[] = [];
  for (const [path, was] of before) {
    const now = after.get(path);
    if (now && now.compatible > was.version) out.push(path.slice(profile.length + 1));
  }
  return out;
}
