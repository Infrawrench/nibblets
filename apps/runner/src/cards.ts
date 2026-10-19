import type { CardFile } from "@nibblet/protocol";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The cards the server hands the agent, one JSON file each, readable only by
 * the agent's user. They live outside the home folder, so they're never in a
 * snapshot, and go with the container; the server writes them again when it
 * reconnects. The card's number goes nowhere else in the container.
 */
export class CardFiles {
  private readonly dir: string;
  /**
   * Each card's writes and removals, one at a time, so a removal sent while
   * a put is still landing (a server that timed out on it) can't run first.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Writes the card's file (whole, or not at all) and says where it is. */
  async put(file: CardFile): Promise<string> {
    const path = this.pathOf(file.id);
    return this.serially(file.id, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      // A folder left by another umask would otherwise keep its mode.
      await chmod(this.dir, 0o700);
      const partial = `${path}.partial`;
      await writeFile(partial, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(partial, path);
      return path;
    });
  }

  async remove(cardId: string): Promise<void> {
    const path = this.pathOf(cardId);
    return this.serially(cardId, async () => {
      await rm(path, { force: true });
      await rm(`${path}.partial`, { force: true });
    });
  }

  private serially<T>(cardId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(cardId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(cardId, settled);
    // Forget the card once nothing's waiting on it.
    void settled.then(() => {
      if (this.queues.get(cardId) === settled) this.queues.delete(cardId);
    });
    return next;
  }

  pathOf(cardId: string): string {
    if (!SAFE_ID.test(cardId)) throw new Error(`"${cardId}" isn't a card id`);
    return join(this.dir, `${cardId}.json`);
  }
}
