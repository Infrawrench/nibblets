import type { CardFile, RunnerToServer, ServerToRunner } from "@nibblets/protocol";
import { RunnerRequests } from "./runner-requests.ts";

type Done = Extract<RunnerToServer, { type: "card_done" }>;

/**
 * Card files in nibblets' containers, written by their runners over the
 * runner socket: the only way a card's details reach a container. Each
 * request waits for the runner to say it's done.
 */
export class CardFiles {
  private readonly requests: RunnerRequests<Done>;

  /** `send` says whether the nibblet's runner is connected to send to. */
  constructor(send: (nibbletId: string, message: ServerToRunner) => boolean, timeoutMs = 30_000) {
    this.requests = new RunnerRequests("cardreq", send, timeoutMs);
  }

  /** Writes a card's file in its container and returns the path. */
  async put(nibbletId: string, file: CardFile): Promise<string> {
    const done = await this.requests.request(nibbletId, (requestId) => ({
      type: "card_put",
      requestId,
      file,
    }));
    if (!done.path) throw new Error("Its container didn't say where it put the card");
    return done.path;
  }

  async remove(nibbletId: string, cardId: string): Promise<void> {
    await this.requests.request(nibbletId, (requestId) => ({
      type: "card_remove",
      requestId,
      cardId,
    }));
  }

  fromRunner(nibbletId: string, done: Done): void {
    this.requests.fromRunner(nibbletId, done);
  }

  /** Its runner went away: nothing it was asked will be answered. */
  runnerGone(nibbletId: string): void {
    this.requests.runnerGone(nibbletId);
  }
}
