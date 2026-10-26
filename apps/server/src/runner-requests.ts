import type { ServerToRunner } from "@nibblets/protocol";
import { newId } from "./store.ts";

interface Pending<Done> {
  nibbletId: string;
  resolve(done: Done): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Requests to nibblets' runners over the runner socket that the runner
 * answers by `requestId`, with an `error` when it couldn't do it.
 */
export class RunnerRequests<Done extends { requestId: string; error: string | null }> {
  private readonly pending = new Map<string, Pending<Done>>();
  private readonly prefix: string;
  private readonly send: (nibbletId: string, message: ServerToRunner) => boolean;
  private readonly timeoutMs: number;

  /** `send` says whether the nibblet's runner is connected to send to. */
  constructor(
    prefix: string,
    send: (nibbletId: string, message: ServerToRunner) => boolean,
    timeoutMs: number,
  ) {
    this.prefix = prefix;
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  request(nibbletId: string, message: (requestId: string) => ServerToRunner): Promise<Done> {
    const requestId = newId(this.prefix);
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
}
