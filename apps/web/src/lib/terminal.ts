import { TerminalEvent, type BackgroundTask, type TerminalInput } from "@nibblets/protocol";
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

/** Output drawn is acknowledged in batches this big, or after ACK_AFTER_MS. */
const ACK_EVERY_CHARS = 32 * 1024;
const ACK_AFTER_MS = 100;
/** Typing that waits for the socket to open, at most. */
const MAX_EARLY_INPUT = 64 * 1024;

/**
 * One terminal's socket. Opens with a fresh ticket, and says when the
 * shell (or the task's output) has ended, or why it couldn't start. Tell it
 * when output has been drawn (`drawn`), or the container stops sending more.
 */
export class TerminalSocket {
  private readonly events: TerminalEvents;
  private ws: WebSocket | null = null;
  private closed = false;
  /** The latest size, sent once the socket opens in case it changed on the way. */
  private size = { cols: 80, rows: 24 };
  private early = "";
  private toAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.size = size;
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
    ws.onopen = () => {
      this.events.state("open");
      this.send({ type: "resize", ...this.size });
      if (this.early) this.send({ type: "input", data: this.early });
      this.early = "";
    };
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

  private get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  input(data: string): void {
    if (this.isOpen) this.send({ type: "input", data });
    else if (!this.closed) this.early = (this.early + data).slice(-MAX_EARLY_INPUT);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.send({ type: "resize", cols, rows });
  }

  /** This much output (as it arrived, in string length) has been drawn. */
  drawn(chars: number): void {
    this.toAck += chars;
    if (this.toAck >= ACK_EVERY_CHARS) this.flushAck();
    else this.ackTimer ??= setTimeout(() => this.flushAck(), ACK_AFTER_MS);
  }

  private flushAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.toAck > 0) this.send({ type: "ack", chars: this.toAck });
    this.toAck = 0;
  }

  close(): void {
    this.closed = true;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ws?.close();
  }
}

/** "running", or how it ended. */
export function describeTask(task: BackgroundTask): string {
  if (task.status === "running") return "running";
  return task.exitCode === null ? "stopped" : `exited with ${task.exitCode}`;
}
