import { TerminalEvent, type BackgroundTask, type TerminalInput } from "@nibblet/protocol";
import type { ServerConnection } from "./connection.ts";

/** Where a terminal in a nibblet's container is served: a shell, or a task's output. */
export function terminalPath(
  nibbletId: string,
  size: { cols: number; rows: number },
  taskId: string | null,
): string {
  const params = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) });
  if (taskId) params.set("task", taskId);
  return `/api/nibblets/${encodeURIComponent(nibbletId)}/terminal?${params}`;
}

export function parseTerminalEvent(raw: unknown): TerminalEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = TerminalEvent.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type TerminalState = "connecting" | "open" | "exited";

export interface TerminalEvents {
  output(data: string): void;
  /** `detail` says why it ended, when that's worth saying. */
  state(state: TerminalState, detail?: string): void;
}

/**
 * One terminal's socket. Opens with a fresh ticket, and says when the
 * shell (or the task's output) has ended, or why it couldn't start.
 */
export class TerminalSocket {
  private readonly events: TerminalEvents;
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(events: TerminalEvents) {
    this.events = events;
  }

  async open(
    connection: ServerConnection,
    nibbletId: string,
    size: { cols: number; rows: number },
    taskId: string | null,
  ): Promise<void> {
    this.events.state("connecting");
    let url: string;
    try {
      url = await connection.socketUrl(terminalPath(nibbletId, size, taskId));
    } catch (err) {
      this.events.state("exited", err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.closed) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    let ended = false;
    ws.onopen = () => this.events.state("open");
    ws.onmessage = (e) => {
      const event = parseTerminalEvent(e.data);
      if (!event) return;
      if (event.type === "output") this.events.output(event.data);
      else {
        ended = true;
        this.events.state(
          "exited",
          event.type === "error"
            ? event.message
            : event.code === null || event.code === 0
              ? undefined
              : `Exited with ${event.code}`,
        );
      }
    };
    ws.onclose = () => {
      if (!ended && !this.closed) this.events.state("exited", "The connection dropped.");
    };
  }

  private send(message: TerminalInput): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  input(data: string): void {
    this.send({ type: "input", data });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: "resize", cols, rows });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/** "running", or how it ended. */
export function describeTask(task: BackgroundTask): string {
  if (task.status === "running") return "running";
  return task.exitCode === null ? "stopped" : `exited with ${task.exitCode}`;
}
