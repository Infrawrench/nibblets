import type { BackgroundTask, RunnerToServer, ServerToRunner } from "@nibblet/protocol";
import { randomBytes } from "node:crypto";

/** Where a terminal's output goes: the browser that opened it. */
export interface TerminalSink {
  output(data: string): void;
  exit(code: number | null): void;
}

type FromRunner = Extract<RunnerToServer, { type: "terminal_output" | "terminal_exit" | "tasks" }>;

/**
 * The user's terminals in nibblets' containers, carried over each runner's
 * socket, and the background tasks each runner reports. A runner can only
 * write to terminals opened on it.
 */
export class TerminalHub {
  private readonly send: (nibbletId: string, message: ServerToRunner) => boolean;
  private readonly open = new Map<string, { nibbletId: string; sink: TerminalSink }>();
  private readonly tasks = new Map<string, BackgroundTask[]>();

  /** `send` returns false when the nibblet has no runner connected. */
  constructor(send: (nibbletId: string, message: ServerToRunner) => boolean) {
    this.send = send;
  }

  /** Opens a terminal, or a task's output when given one; null if the nibblet isn't running. */
  openTerminal(
    nibbletId: string,
    size: { cols: number; rows: number },
    taskId: string | null,
    sink: TerminalSink,
  ): string | null {
    const terminalId = `term_${randomBytes(9).toString("base64url")}`;
    this.open.set(terminalId, { nibbletId, sink });
    if (!this.send(nibbletId, { type: "terminal_open", terminalId, ...size, taskId })) {
      this.open.delete(terminalId);
      return null;
    }
    return terminalId;
  }

  input(terminalId: string, data: string): void {
    const t = this.open.get(terminalId);
    if (t) this.send(t.nibbletId, { type: "terminal_input", terminalId, data });
  }

  resize(terminalId: string, size: { cols: number; rows: number }): void {
    const t = this.open.get(terminalId);
    if (t) this.send(t.nibbletId, { type: "terminal_resize", terminalId, ...size });
  }

  /** The browser went away: hang up the shell. */
  close(terminalId: string): void {
    const t = this.open.get(terminalId);
    if (!t) return;
    this.open.delete(terminalId);
    this.send(t.nibbletId, { type: "terminal_close", terminalId });
  }

  fromRunner(nibbletId: string, message: FromRunner): void {
    if (message.type === "tasks") {
      this.tasks.set(nibbletId, message.tasks);
      return;
    }
    const t = this.open.get(message.terminalId);
    if (!t || t.nibbletId !== nibbletId) return;
    if (message.type === "terminal_output") {
      t.sink.output(message.data);
    } else {
      this.open.delete(message.terminalId);
      t.sink.exit(message.code);
    }
  }

  /** Its runner disconnected: its terminals are gone, and so may its tasks be. */
  runnerGone(nibbletId: string): void {
    this.tasks.delete(nibbletId);
    for (const [id, t] of this.open) {
      if (t.nibbletId !== nibbletId) continue;
      this.open.delete(id);
      t.sink.exit(null);
    }
  }

  tasksOf(nibbletId: string): BackgroundTask[] {
    return this.tasks.get(nibbletId) ?? [];
  }

  stopTask(nibbletId: string, taskId: string): boolean {
    return this.send(nibbletId, { type: "task_stop", taskId });
  }
}
