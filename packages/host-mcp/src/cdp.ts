import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * A browser started with `--remote-debugging-pipe`, and the DevTools
 * protocol over that pipe: messages are JSON, each ended by a NUL, written
 * to its fd 3 and read from its fd 4. Only this process holds the pipe, so
 * no web page or other program can reach it.
 */
export class PipeBrowser {
  readonly child: ChildProcess;
  /** Resolves when the browser process has exited. */
  readonly exited: Promise<void>;
  private readonly input: Writable;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly listeners = new Map<string, ((params: unknown) => void)[]>();

  constructor(bin: string, args: string[]) {
    this.child = spawn(bin, ["--remote-debugging-pipe", ...args], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    this.input = this.child.stdio[3] as Writable;
    const output = this.child.stdio[4] as Readable;
    // A write after it's gone is answered by the exit, not an uncaught error.
    this.input.on("error", () => undefined);
    let buffer = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.receive(message);
      }
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    void this.exited.then(() => {
      for (const { reject } of this.pending.values()) reject(new Error("the browser exited"));
      this.pending.clear();
    });
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      if (this.child.exitCode !== null) return reject(new Error("the browser exited"));
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  on(event: string, listener: (params: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  /** Asks it to close, killing it if it hasn't within `ms`. */
  async close(ms = 10_000): Promise<void> {
    if (this.child.exitCode !== null) return;
    void this.send("Browser.close").catch(() => undefined);
    const timer = setTimeout(() => this.child.kill("SIGKILL"), ms);
    await this.exited;
    clearTimeout(timer);
  }

  private receive(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    } else if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    }
  }
}
