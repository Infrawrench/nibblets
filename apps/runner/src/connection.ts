import WebSocket from "ws";
import { RunnerToServer, ServerToRunner } from "@nibblet/protocol";

const PING_MS = 20_000;
const MAX_BACKLOG = 5_000;

/**
 * A WebSocket to the server that survives the server restarting. Messages
 * sent while disconnected wait in a backlog, so a turn that finishes during
 * a blip still reports its items.
 */
export class Connection {
  private readonly url: string;
  private readonly token: string;
  private readonly onMessage: (msg: ServerToRunner) => void;
  private readonly onOpen: () => void;
  private ws: WebSocket | null = null;
  private backlog: string[] = [];
  private attempt = 0;
  private closed = false;

  constructor(opts: {
    url: string;
    token: string;
    onMessage: (msg: ServerToRunner) => void;
    onOpen: () => void;
  }) {
    this.url = opts.url;
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.onOpen = opts.onOpen;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    let alive = true;
    let ping: ReturnType<typeof setInterval> | null = null;

    ws.on("open", () => {
      this.attempt = 0;
      this.onOpen();
      const pending = this.backlog;
      this.backlog = [];
      for (const raw of pending) ws.send(raw);
      ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, PING_MS);
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        console.error("runner: unparseable message from server");
        return;
      }
      const msg = ServerToRunner.safeParse(parsed);
      if (msg.success) this.onMessage(msg.data);
      else console.error("runner: unexpected message from server", msg.error.message);
    });
    ws.on("close", () => {
      if (ping) clearInterval(ping);
      this.ws = null;
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (err) => {
      console.error(`runner: socket error: ${err.message}`);
    });
  }

  send(msg: RunnerToServer): void {
    const raw = JSON.stringify(RunnerToServer.parse(msg));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
      return;
    }
    this.backlog.push(raw);
    if (this.backlog.length > MAX_BACKLOG)
      this.backlog.splice(0, this.backlog.length - MAX_BACKLOG);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
