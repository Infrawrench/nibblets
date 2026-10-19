import type { CardFile, RunnerToServer, ServerToRunner } from "@nibblet/protocol";
import { newId } from "./store.ts";

type Done = Extract<RunnerToServer, { type: "card_done" }>;

interface Pending {
  nibbletId: string;
  resolve(done: Done): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Card files in nibblets' containers, written by their runners over the
 * runner socket: the only way a card's details reach a container. Each
 * request waits for the runner to say it's done.
 */
export class CardFiles {
  private readonly pending = new Map<string, Pending>();
  private readonly send: (nibbletId: string, message: ServerToRunner) => boolean;
  private readonly timeoutMs: number;

  /** `send` says whether the nibblet's runner is connected to send to. */
  constructor(send: (nibbletId: string, message: ServerToRunner) => boolean, timeoutMs = 30_000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  /** Writes a card's file in its container and returns the path. */
  async put(nibbletId: string, file: CardFile): Promise<string> {
    const done = await this.request(nibbletId, (requestId) => ({
      type: "card_put",
      requestId,
      file,
    }));
    if (!done.path) throw new Error("Its container didn't say where it put the card");
    return done.path;
  }

  async remove(nibbletId: string, cardId: string): Promise<void> {
    await this.request(nibbletId, (requestId) => ({ type: "card_remove", requestId, cardId }));
  }

  fromRunner(nibbletId: string, done: Done): void {
    const pending = this.pending.get(done.requestId);
    if (!pending || pending.nibbletId !== nibbletId) return;
    this.pending.delete(done.requestId);
    clearTimeout(pending.timer);
    if (done.error) pending.reject(new Error(done.error));
    else pending.resolve(done);
  }

  /** Its runner went away: nothing it was asked will be answered. */
  runnerGone(nibbletId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.nibbletId !== nibbletId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error("Lost touch with its container"));
    }
  }

  private request(nibbletId: string, message: (requestId: string) => ServerToRunner) {
    const requestId = newId("cardreq");
    return new Promise<Done>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Its container didn't answer in time"));
      }, this.timeoutMs);
      this.pending.set(requestId, { nibbletId, resolve, reject, timer });
      if (!this.send(nibbletId, message(requestId))) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Its container isn't running"));
      }
    });
  }
}
