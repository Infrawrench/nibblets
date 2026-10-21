import type { RunnerToServer, ServerToRunner } from "@nibblets/protocol";
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/** More than anyone needs at once; each is a shell and a pty. */
const MAX_TERMINALS = 8;
/**
 * Output sent but not yet drawn by the browser, past which a terminal stops
 * reading until it catches up (and below which it starts again). Keeps a
 * flood (`yes`, a huge `cat`) from piling up here, on the server, and in
 * front of the turn's own messages on the same socket.
 */
const PAUSE_AT = 512 * 1024;
const RESUME_AT = 128 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";

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
  /** The shell to start; a login bash by default (PowerShell on Windows). */
  shell?: string[];
}

/** A command in a pseudo-terminal, however this OS makes one. */
interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Hangs the command up, as closing a terminal window does. */
  hangUp(): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(handler: (chunk: Buffer | string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  onError(handler: (err: Error) => void): void;
}

type PtyMaker = (
  command: string[],
  size: { cols: number; rows: number },
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Pty;

/**
 * Python's pty module, on Linux: node-pty would need a compiler the runner
 * image doesn't have. See terminal-pty.py.
 */
const pythonPty: PtyMaker = (command, size, opts) => {
  const child = spawn(
    "python3",
    ["-I", path.join(here, "terminal-pty.py"), String(size.rows), String(size.cols), ...command],
    { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "inherit", "pipe"] },
  );
  const resize = child.stdio[3];
  const sizes = resize instanceof Writable ? resize : null;
  sizes?.on("error", () => {});
  child.stdin?.on("error", () => {});
  return {
    write: (data) => void child.stdin?.write(data),
    resize: (cols, rows) => void sizes?.write(`${rows} ${cols}\n`),
    hangUp: () => {
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000).unref();
    },
    kill: () => child.kill("SIGKILL"),
    pause: () => child.stdout?.pause(),
    resume: () => child.stdout?.resume(),
    onData: (handler) => void child.stdout?.on("data", handler),
    onExit: (handler) => void child.on("close", (code) => handler(code)),
    onError: (handler) => void child.on("error", handler),
  };
};

/** The bits of node-pty used here, as it exports them. */
interface NodePty {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
    onData(handler: (data: string) => void): void;
    onExit(handler: (e: { exitCode: number; signal?: number }) => void): void;
  };
}

/**
 * Installs drop the execute bit from node-pty's prebuilt spawn-helper, and
 * without it nothing starts; put back where this user may.
 */
async function fixSpawnHelper(): Promise<void> {
  if (process.platform === "win32") return;
  const root = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const helper = path.join(
    root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  await chmod(helper, 0o755).catch(() => undefined);
}

/** node-pty, on macOS and Windows, where it comes built; null where it doesn't load. */
async function loadNodePty(): Promise<PtyMaker | null> {
  const loaded: NodePty | null = await import("node-pty").catch(() => null);
  if (!loaded) return null;
  await fixSpawnHelper().catch(() => undefined);
  return (command, size, opts) => {
    const [file = "", ...args] = command;
    const pty = loaded.spawn(file, args, { name: "xterm-256color", ...size, ...opts });
    // node-pty says a command has exited once it's read all its output, which
    // it may never finish after a pause: a hang-up makes sure, and says so itself.
    const exits: ((code: number | null) => void)[] = [];
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      for (const handler of exits) handler(code);
    };
    pty.onExit((e) => exit(e.exitCode));
    return {
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      hangUp: () => {
        pty.kill(windows ? undefined : "SIGHUP");
        setTimeout(() => {
          if (exited) return;
          pty.kill(windows ? undefined : "SIGKILL");
          setTimeout(() => exit(null), 1000).unref();
        }, 1500).unref();
      },
      kill: () => pty.kill(),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
      onData: (handler) => pty.onData(handler),
      onExit: (handler) => void exits.push(handler),
      onError: () => {},
    };
  };
}

interface Terminal {
  pty: Pty;
  /** Output sent that the browser hasn't said it's drawn. */
  unacked: number;
  paused: boolean;
}

/**
 * The user's terminals in its machine, over the runner's socket: each is a
 * login shell (or a background task's log, followed) in a real
 * pseudo-terminal, as the agent's user, since that's who the runner is. The
 * guard's home and environment are as out of reach here as from the agent.
 */
export class Terminals {
  private readonly opts: TerminalsOptions;
  private readonly open = new Map<string, Terminal>();
  /** What came for a terminal while its pty was still being made, to give it once it is. */
  private readonly starting = new Map<string, TerminalMessage[]>();
  /** How this OS makes a pty: Python's on Linux, node-pty's elsewhere. */
  private readonly maker: Promise<PtyMaker | null>;

  constructor(opts: TerminalsOptions) {
    this.opts = opts;
    this.maker =
      process.platform === "linux"
        ? Promise.resolve(pythonPty)
        : loadNodePty().then((made) => made ?? (windows ? null : pythonPty));
  }

  handle(msg: TerminalMessage): void {
    const waiting = msg.type === "terminal_open" ? undefined : this.starting.get(msg.terminalId);
    if (waiting) {
      waiting.push(msg);
      return;
    }
    switch (msg.type) {
      case "terminal_open":
        void this.start(msg);
        return;
      case "terminal_input":
        this.open.get(msg.terminalId)?.pty.write(msg.data);
        return;
      case "terminal_resize":
        this.open.get(msg.terminalId)?.pty.resize(msg.cols, msg.rows);
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
          terminal.pty.resume();
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
    // Nobody's drawing its output any more, so stop holding it back.
    if (terminal.paused) {
      terminal.paused = false;
      terminal.pty.resume();
    }
    terminal.pty.hangUp();
  }

  /** What a terminal runs: the shell, or a task's log, followed. */
  private command(taskLog: string | null): string[] {
    if (taskLog) {
      return windows
        ? [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Get-Content -Tail 1000 -Wait -LiteralPath $env:NIBBLET_TASK_LOG",
          ]
        : ["tail", "-n", "1000", "-F", taskLog];
    }
    return this.opts.shell ?? (windows ? ["powershell.exe", "-NoLogo"] : ["bash", "-l"]);
  }

  private async start(msg: Extract<TerminalMessage, { type: "terminal_open" }>): Promise<void> {
    const { terminalId } = msg;
    const fail = (text: string) => {
      this.opts.send({ type: "terminal_output", terminalId, data: `${text}\r\n` });
      this.opts.send({ type: "terminal_exit", terminalId, code: null });
    };
    if (this.open.has(terminalId)) return;
    if (this.open.size >= MAX_TERMINALS) return fail("Too many terminals are open.");
    const log = msg.taskId ? this.opts.taskLog(msg.taskId) : null;
    if (msg.taskId && !log) return fail("That task has gone.");
    if (this.starting.has(terminalId)) return;
    this.starting.set(terminalId, []);
    const maker = await this.maker;
    const waited = this.starting.get(terminalId) ?? [];
    this.starting.delete(terminalId);
    if (!maker) return fail("There's no way to open a terminal here.");
    if (this.open.has(terminalId)) return;
    const pty = maker(
      this.command(log),
      { cols: msg.cols, rows: msg.rows },
      {
        cwd: this.opts.workdir,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          ...(log ? { NIBBLET_TASK_LOG: log } : {}),
        },
      },
    );
    const terminal: Terminal = { pty, unacked: 0, paused: false };
    this.open.set(terminalId, terminal);
    // Output can stop partway through a character; the decoder holds it for the next chunk.
    const decoder = new StringDecoder("utf8");
    pty.onData((chunk) => {
      const data = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (!data) return;
      this.opts.send({ type: "terminal_output", terminalId, data });
      terminal.unacked += data.length;
      if (!terminal.paused && terminal.unacked > PAUSE_AT) {
        terminal.paused = true;
        pty.pause();
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
    pty.onError((err) => {
      this.opts.send({
        type: "terminal_output",
        terminalId,
        data: `Couldn't open a terminal: ${err.message}\r\n`,
      });
      end(null);
    });
    pty.onExit((code) => end(code));
    for (const queued of waited) this.handle(queued);
  }
}
