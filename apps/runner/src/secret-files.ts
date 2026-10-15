import { SECRET_FILES_DIR } from "@nibblet/protocol";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Secrets the server hands this nibblet to use (a card's details), kept in
 * private files outside its home folder: snapshots never include them, and
 * they go when the container does.
 */
export class SecretFiles {
  private readonly dir: string;

  constructor(dir = SECRET_FILES_DIR) {
    this.dir = dir;
  }

  /** Writes a file readable only by this user and returns its path; null content removes it. */
  async put(name: string, content: string | null): Promise<string | null> {
    // The protocol only allows bare names, but never write outside the folder.
    if (basename(name) !== name || name.startsWith(".")) throw new Error(`Bad file name ${name}`);
    const path = join(this.dir, name);
    if (content === null) {
      await rm(path, { force: true });
      return null;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }
}
