import type {
  BackgroundTask,
  DesktopApp,
  RunnerToServer,
  ServerToRunner,
} from "@nibblets/protocol";
import { randomBytes } from "node:crypto";

/** Where a terminal's output goes: the browser that opened it. */
export interface TerminalSink {
  output(data: string): void;
  exit(code: number | null): void;
}

type FromRunner = Extract<
  RunnerToServer,
  { type: "terminal_output" | "terminal_exit" | "tasks" | "apps" }
>;

/**
 * The user's terminals in nibblets' containers, carried over each runner's
 * socket, and the background tasks and desktop apps each runner reports. A
 * runner can only write to terminals opened on it.
 */
export class TerminalHub {
  private readonly send: (nibbletId: string, message: ServerToRunner) => boolean;
  private readonly open = new Map<string, { nibbletId: string; sink: TerminalSink }>();
  private readonly tasks = new Map<string, BackgroundTask[]>();
  /** Told whenever a nibblet's tasks change, to pass on to the UI. */
  onTasks: (nibbletId: string, tasks: BackgroundTask[]) => void = () => {};
  private readonly apps = new Map<string, DesktopApp[]>();
  /** Told whenever a nibblet's apps change, to pass on to the UI. */
  onApps: (nibbletId: string, apps: DesktopApp[]) => void = () => {};

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

  /** The browser has drawn this much of its output. */
  ack(terminalId: string, chars: number): void {
    const t = this.open.get(terminalId);
    if (t) this.send(t.nibbletId, { type: "terminal_ack", terminalId, chars });
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
      this.onTasks(nibbletId, message.tasks);
      return;
    }
    if (message.type === "apps") {
      this.apps.set(nibbletId, message.apps);
      this.onApps(nibbletId, message.apps);
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
    if (this.tasks.delete(nibbletId)) this.onTasks(nibbletId, []);
    if (this.apps.delete(nibbletId)) this.onApps(nibbletId, []);
    for (const [id, t] of this.open) {
      if (t.nibbletId !== nibbletId) continue;
      this.open.delete(id);
      t.sink.exit(null);
    }
  }

  tasksOf(nibbletId: string): BackgroundTask[] {
    return this.tasks.get(nibbletId) ?? [];
  }

  appsOf(nibbletId: string): DesktopApp[] {
    return this.apps.get(nibbletId) ?? [];
  }

  /** Asks its runner to look for apps again; what it finds comes back as `apps`. */
  scanApps(nibbletId: string): boolean {
    return this.send(nibbletId, { type: "apps_scan" });
  }

  stopTask(nibbletId: string, taskId: string): boolean {
    return this.send(nibbletId, { type: "task_stop", taskId });
  }
}
