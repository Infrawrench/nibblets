import { readFile, writeFile } from "node:fs/promises";
import { defineSource, type CredentialSource } from "./source.ts";

/**
 * A credential file bind-mounted from the host, one file per mount.
 *
 * Writes go in place rather than through a temporary file and a rename:
 * Docker binds a single file by inode, and a rename would swap the inode
 * inside the container while the host kept the stale file. The documents
 * are a few hundred bytes, written with one call, so the window in which
 * the host's CLI could read a partial file is tiny, and that CLI already
 * retries a failed read. Mounting the whole `~/.claude` directory to get
 * an atomic rename would hand the container far more than it needs.
 */
export function fileSource(path: string): CredentialSource {
  return defineSource({
    kind: "file",
    async load() {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async save(text) {
      await writeFile(path, text);
    },
    writable: () => true,
    describe: () => path,
  });
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
