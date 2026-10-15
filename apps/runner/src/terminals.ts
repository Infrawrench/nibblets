import type { RunnerToServer, ServerToRunner } from "@nibblet/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";

/** More than anyone needs at once; each is a shell and a Python process. */
const MAX_TERMINALS = 8;
/**
 * Output sent but not yet drawn by the browser, past which a terminal stops
 * reading until it catches up (and below which it starts again). Keeps a
 * flood (`yes`, a huge `cat`) from piling up here, on the server, and in
 * front of the turn's own messages on the same socket.
 */
const PAUSE_AT = 512 * 1024;
const RESUME_AT = 128 * 1024;
const here = path.dirname(new URL(import.meta.url).pathname);

type TerminalMessage = Extract<
  ServerToRunner,
  {
    type:
      "terminal_open" | "terminal_input" | "terminal_resize" | "terminal_close" | "terminal_ack";
  }
>;

export interface TerminalsOptions {
  workdir: string;
  send(msg: RunnerToServer): void;
  /** A background task's log, to follow in a terminal; null for no such task. */
  taskLog(taskId: string): string | null;
  /** The shell to start; a login bash by default. */
  shell?: string[];
}

interface Terminal {
  child: ChildProcess;
  resize: Writable;
  /** Output sent that the browser hasn't said it's drawn. */
  unacked: number;
  paused: boolean;
}

/**
 * The user's terminals in the container, over the runner's socket: each is
 * a login shell (or `tail -F` of a background task's log) in a real
 * pseudo-terminal, as the agent's user, since that's who the runner is. The
 * guard's home and environment are as out of reach here as from the agent.
 */
export class Terminals {
  private readonly opts: TerminalsOptions;
  private readonly open = new Map<string, Terminal>();

  constructor(opts: TerminalsOptions) {
    this.opts = opts;
  }

  handle(msg: TerminalMessage): void {
    switch (msg.type) {
      case "terminal_open":
        this.start(msg);
        return;
      case "terminal_input":
        this.open.get(msg.terminalId)?.child.stdin?.write(msg.data);
        return;
      case "terminal_resize":
        this.open.get(msg.terminalId)?.resize.write(`${msg.rows} ${msg.cols}\n`);
        return;
      case "terminal_close":
        this.close(msg.terminalId);
        return;
      case "terminal_ack": {
        const terminal = this.open.get(msg.terminalId);
        if (!terminal) return;
        terminal.unacked = Math.max(0, terminal.unacked - msg.chars);
        if (terminal.paused && terminal.unacked <= RESUME_AT) {
          terminal.paused = false;
          terminal.child.stdout?.resume();
        }
        return;
      }
    }
  }

  /** Hangs up every terminal: the server that held them has gone. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id);
  }

  private close(id: string): void {
    const terminal = this.open.get(id);
    if (!terminal) return;
    // Closing its input hangs up the shell, as closing a terminal window does.
    // Nobody's drawing its output any more, so stop holding it back.
    terminal.child.stdin?.end();
    if (terminal.paused) {
      terminal.paused = false;
      terminal.child.stdout?.resume();
    }
    setTimeout(() => {
      if (terminal.child.exitCode === null) terminal.child.kill("SIGKILL");
    }, 5000).unref();
  }

  private start(msg: Extract<TerminalMessage, { type: "terminal_open" }>): void {
    const { terminalId } = msg;
    const fail = (text: string) => {
      this.opts.send({ type: "terminal_output", terminalId, data: `${text}\r\n` });
      this.opts.send({ type: "terminal_exit", terminalId, code: null });
    };
    if (this.open.has(terminalId)) return;
    if (this.open.size >= MAX_TERMINALS) return fail("Too many terminals are open.");
    let command = this.opts.shell ?? ["bash", "-l"];
    if (msg.taskId) {
      const log = this.opts.taskLog(msg.taskId);
      if (!log) return fail("That task has gone.");
      command = ["tail", "-n", "1000", "-F", log];
    }
    const child = spawn(
      "python3",
      ["-I", path.join(here, "terminal-pty.py"), String(msg.rows), String(msg.cols), ...command],
      {
        cwd: this.opts.workdir,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      },
    );
    const resize = child.stdio[3] as Writable;
    resize.on("error", () => {});
    child.stdin?.on("error", () => {});
    const terminal: Terminal = { child, resize, unacked: 0, paused: false };
    this.open.set(terminalId, terminal);
    // Output can stop partway through a character; the decoder holds it for the next chunk.
    const decoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      const data = decoder.write(chunk);
      if (!data) return;
      this.opts.send({ type: "terminal_output", terminalId, data });
      terminal.unacked += data.length;
      if (!terminal.paused && terminal.unacked > PAUSE_AT) {
        terminal.paused = true;
        child.stdout?.pause();
      }
    });
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      this.open.delete(terminalId);
      const rest = decoder.end();
      if (rest) this.opts.send({ type: "terminal_output", terminalId, data: rest });
      this.opts.send({ type: "terminal_exit", terminalId, code });
    };
    child.on("error", (err) => {
      this.opts.send({
        type: "terminal_output",
        terminalId,
        data: `Couldn't open a terminal: ${err.message}\r\n`,
      });
      end(null);
    });
    child.on("close", (code) => end(code));
  }
}
