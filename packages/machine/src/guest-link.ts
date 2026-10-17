import { Duplex, Writable, type Readable } from "node:stream";
import {
  decodeFrame,
  encodeFrame,
  GuestToServer,
  type EntryCommand,
  type GuestOs,
  type GuestSignal,
  type ServerToGuest,
} from "@nibblet/protocol";

/** The server's end of a guest's link, as a WebSocket (to the host bridge) or anything like one. */
export interface GuestSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  /** Stops and starts taking messages, for one that can be held back. */
  pause?(): void;
  resume?(): void;
}

export interface RunExit {
  code: number | null;
  signal: string | null;
  /** Why it never started, or what became of it, when it didn't end by itself. */
  error: string | null;
}

export interface RunOptions {
  /** Its name: `main`, `subagent:<id>`, or anything unique while it runs. */
  run: string;
  command: EntryCommand;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  /** Piped to its stdin, which is closed once this ends (or at once, without it). */
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

/** Past this much waiting to go out, what's being piped in waits. */
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may be waiting on it when the link drops.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export class GuestGone extends Error {
  constructor() {
    super("Lost touch with its virtual machine");
  }
}

/** Waits for `socket` to have room, resolving at once when it has. */
function room(socket: GuestSocket, gone: () => boolean): Promise<void> {
  if (socket.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const wait = setInterval(() => {
      if (gone() || socket.bufferedAmount < LOW_WATER) {
        clearInterval(wait);
        resolve();
      }
    }, 20);
  });
}

/**
 * The server's link to a guest agent: runs its entry's commands, and opens
 * connections to ports inside the guest. Built on a `GuestSocket`, so it's
 * testable without one.
 *
 * A run outlives the link. If the socket drops, the guest carries on, and
 * on the next link its agent says what's still running and how the rest
 * ended. So exits are kept for whoever asks, on whichever link hears them.
 */
export class GuestLink {
  readonly nibbletId: string;
  readonly boot: string;
  os: GuestOs = "linux";
  version = "";
  /** What it has running, as far as this link has heard. */
  private readonly runs = new Set<string>();
  /** Settles when the socket goes. */
  readonly gone: Promise<void>;
  /** What its agent logs. */
  log: (level: "info" | "warn" | "error", message: string) => void = () => {};

  private readonly socket: GuestSocket;
  private readonly onGone: () => void;
  private readonly hello = deferred<void>();
  private nextChannel = 1;
  private nextRequest = 1;
  /** Jobs' names, unique to this link, so an old job's exit is never a new one's. */
  private readonly jobPrefix = `job:${Math.random().toString(36).slice(2, 10)}`;
  private helloed = false;
  private isGone = false;
  /** Runs whose output was cut off, so they can't be said to have ended well. */
  private readonly cutOff = new Set<string>();
  /** Runs this link has heard the end of. */
  private readonly ended = new Set<string>();
  /** Which run each output channel is, to know whose was cut off. */
  private readonly channelRuns = new Map<number, string>();
  /** Where each channel's incoming bytes go. */
  private readonly sinks = new Map<number, (data: Uint8Array) => void>();
  private readonly started = new Map<string, Deferred<number>>();
  private readonly exits = new Map<string, Deferred<RunExit>>();
  private readonly tails = new Map<string, Deferred<string>>();
  private readonly opens = new Map<number, Deferred<void>>();
  /** Ends a channel's stream when it's closed from the other side, or the link goes. */
  private readonly closers = new Map<number, () => void>();

  private constructor(socket: GuestSocket, nibbletId: string, boot: string) {
    this.socket = socket;
    this.nibbletId = nibbletId;
    this.boot = boot;
    let onGone = () => {};
    this.gone = new Promise<void>((resolve) => (onGone = resolve));
    this.onGone = onGone;
    socket.onMessage((data) => this.receive(data));
    socket.onClose(() => this.end());
  }

  /** A link over `socket`, once the agent has said hello. */
  static async open(
    socket: GuestSocket,
    machine: { nibbletId: string; boot: string },
    timeoutMs = 30_000,
  ): Promise<GuestLink> {
    const link = new GuestLink(socket, machine.nibbletId, machine.boot);
    link.send({ type: "hello" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        link.hello.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Its agent didn't answer")), timeoutMs);
        }),
      ]);
    } catch (err) {
      link.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return link;
  }

  private receive(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      const frame = decodeFrame(data);
      if (frame) this.sinks.get(frame.channel)?.(frame.data);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = GuestToServer.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case "hello": {
        const running = new Set(msg.runs.map((r) => r.run));
        // Another on the same link: the port started afresh, and what was on its channels is lost.
        if (this.helloed) this.loseChannels();
        this.helloed = true;
        // How the last few runs ended, but not of a name that's running again now.
        for (const exit of msg.exited) if (!running.has(exit.run)) this.settle(exit.run, exit);
        // An agent that's started again (its processes went with it) says
        // nothing of what it had: those runs are over.
        for (const run of [...this.runs]) {
          if (!running.has(run)) {
            this.settle(run, { code: null, signal: null, error: "Its agent restarted" });
          }
        }
        for (const run of running) this.runs.add(run);
        this.os = msg.os;
        this.version = msg.version;
        this.hello.resolve();
        return;
      }
      case "started":
        this.runs.add(msg.run);
        this.started.get(msg.run)?.resolve(msg.pid);
        return;
      case "exited":
        this.settle(msg.run, msg);
        return;
      case "tail":
        this.tails.get(msg.request)?.resolve(msg.text);
        this.tails.delete(msg.request);
        return;
      case "opened":
        this.opens.get(msg.channel)?.resolve();
        this.opens.delete(msg.channel);
        return;
      case "open_failed":
        this.opens.get(msg.channel)?.reject(new Error(msg.error));
        this.opens.delete(msg.channel);
        this.closeChannel(msg.channel);
        return;
      case "closed":
        this.closeChannel(msg.channel);
        return;
      case "log":
        this.log(msg.level, msg.message);
        return;
      case "connect":
        // The bridge answers these on the host; they never reach the server.
        return;
    }
  }

  private settle(run: string, exit: RunExit): void {
    this.runs.delete(run);
    this.ended.add(run);
    this.exitOf(run).resolve({ code: exit.code, signal: exit.signal, error: exit.error });
    // One that never started settles its start too.
    this.started.get(run)?.reject(new Error(exit.error ?? "It exited before it started"));
    this.started.delete(run);
  }

  /** The socket closed. What was waiting on this link is let go; runs carry on in the guest. */
  private end(): void {
    if (this.isGone) return;
    this.isGone = true;
    this.hello.reject(new GuestGone());
    for (const d of [...this.started.values(), ...this.opens.values()]) d.reject(new GuestGone());
    for (const d of this.tails.values()) d.reject(new GuestGone());
    this.started.clear();
    this.tails.clear();
    this.opens.clear();
    for (const channel of [...this.closers.keys()]) this.closeChannel(channel);
    this.sinks.clear();
    this.onGone();
  }

  get closed(): boolean {
    return this.isGone;
  }

  close(): void {
    this.socket.close();
    this.end();
  }

  private send(msg: ServerToGuest): void {
    if (this.isGone) throw new GuestGone();
    this.socket.send(JSON.stringify(msg));
  }

  private exitOf(run: string): Deferred<RunExit> {
    let d = this.exits.get(run);
    if (!d) {
      d = deferred<RunExit>();
      this.exits.set(run, d);
    }
    return d;
  }

  /**
   * Starts one of its entry's commands, resolving once it's running.
   * `exited` then says when it ends.
   */
  async run(opts: RunOptions): Promise<{ pid: number }> {
    const channels = {
      stdin: opts.stdin ? this.nextChannel++ : null,
      stdout: opts.stdout ? this.nextChannel++ : null,
      stderr: opts.stderr ? this.nextChannel++ : null,
    };
    if (channels.stdout !== null && opts.stdout)
      this.pipeOut(channels.stdout, opts.stdout, opts.run);
    if (channels.stderr !== null && opts.stderr)
      this.pipeOut(channels.stderr, opts.stderr, opts.run);
    // A run of the same name from before is over: its exit isn't this one's.
    this.exits.delete(opts.run);
    this.ended.delete(opts.run);
    this.cutOff.delete(opts.run);
    const started = deferred<number>();
    this.started.set(opts.run, started);
    this.send({
      type: "run",
      run: opts.run,
      command: opts.command,
      args: [...(opts.args ?? [])],
      env: { ...opts.env },
      ...channels,
    });
    const pid = await started.promise;
    this.started.delete(opts.run);
    if (channels.stdin !== null) {
      if (opts.stdin) this.pipeIn(channels.stdin, opts.stdin);
    }
    return { pid };
  }

  /** Whether the agent says it's running. */
  isRunning(run: string): boolean {
    return this.runs.has(run);
  }

  /** Whether this link has heard how a run ended. */
  hasExit(run: string): boolean {
    return this.ended.has(run);
  }

  /** How a run ended. Never settles if the link goes first; ask the next link. */
  exited(run: string): Promise<RunExit> {
    return this.exitOf(run).promise;
  }

  /**
   * Runs a command and waits for it to end, failing unless it ends well.
   * For the short ones: stopping a sub-agent, archiving a home folder.
   */
  async runToEnd(opts: Omit<RunOptions, "run">, timeoutMs = 10 * 60_000): Promise<void> {
    const run = `${this.jobPrefix}:${this.nextRequest++}`;
    const stderr: Uint8Array[] = [];
    const collect = new Writable({
      write(chunk: Uint8Array, _enc, done) {
        stderr.push(chunk);
        done();
      },
    });
    await this.run({ ...opts, run, stderr: opts.stderr ?? collect });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whichever loses the race still settles later; nobody's waiting by then.
    const lost = this.gone.then((): never => {
      throw new GuestGone();
    });
    lost.catch(() => {});
    const exit = await Promise.race([
      this.exited(run),
      lost,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${opts.command} took too long`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    this.exits.delete(run);
    if (this.cutOff.delete(run)) throw new Error(`${opts.command}'s output was cut off`);
    if (exit.code !== 0) {
      const said = Buffer.concat(stderr).toString("utf8").trim().slice(-500);
      throw new Error(
        `${opts.command} ${exit.error ?? `exited ${exit.code ?? exit.signal}`}${said ? `: ${said}` : ""}`,
      );
    }
  }

  signal(run: string, signal: GuestSignal): void {
    this.send({ type: "signal", run, signal });
  }

  /** The end of what a run printed, as the agent kept it. */
  async tail(run: string): Promise<string> {
    const request = String(this.nextRequest++);
    const d = deferred<string>();
    this.tails.set(request, d);
    this.send({ type: "tail", request, run });
    return d.promise;
  }

  /** A connection to a port on the guest's loopback. */
  async open(port: number): Promise<Duplex> {
    const channel = this.nextChannel++;
    const opened = deferred<void>();
    this.opens.set(channel, opened);
    const stream = this.channelStream(channel);
    this.send({ type: "open", channel, port });
    try {
      await opened.promise;
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return stream;
  }

  poweroff(): void {
    this.send({ type: "poweroff" });
  }

  /** Bytes on `channel` go to `out`; the empty frame ends it. */
  private pipeOut(channel: number, out: Writable, run: string): void {
    this.channelRuns.set(channel, run);
    this.sinks.set(channel, (data) => {
      if (data.byteLength === 0) {
        this.sinks.delete(channel);
        this.closers.delete(channel);
        this.channelRuns.delete(channel);
        out.end();
      } else out.write(data);
    });
    // Only the empty frame ends it well; anything else is it cut off.
    this.closers.set(channel, () => {
      this.cutOff.add(run);
      // Its reader hears it was cut off if it's listening; it mustn't crash anyone who isn't.
      if (out.listenerCount("error") === 0) out.on("error", () => {});
      out.destroy(new GuestGone());
    });
  }

  /** The port started afresh: every channel's gone, and whoever was reading one is told. */
  private loseChannels(): void {
    for (const channel of [...this.closers.keys()]) this.closeChannel(channel);
    for (const d of this.opens.values()) d.reject(new GuestGone());
    this.opens.clear();
  }

  /** `source` goes out on `channel`, waiting while the socket is backed up; then the empty frame. */
  private pipeIn(channel: number, source: Readable): void {
    const gone = () => this.isGone;
    source.on("data", (chunk: Buffer) => {
      if (this.isGone) {
        source.destroy();
        return;
      }
      this.socket.send(encodeFrame(channel, chunk));
      if (this.socket.bufferedAmount > HIGH_WATER) {
        source.pause();
        void room(this.socket, gone).then(() => source.resume());
      }
    });
    source.once("end", () => {
      if (!this.isGone) this.socket.send(encodeFrame(channel, new Uint8Array(0)));
    });
    source.once("error", () => {
      if (!this.isGone) this.send({ type: "close", channel });
    });
  }

  /** A duplex over `channel`, for an opened connection. */
  private channelStream(channel: number): Duplex {
    const socket = this.socket;
    const gone = () => this.isGone;
    const send = (msg: ServerToGuest) => this.send(msg);
    const forget = () => {
      const had = this.closers.delete(channel);
      this.sinks.delete(channel);
      return had;
    };
    const stream = new Duplex({
      write(chunk: Buffer, _enc, done) {
        if (gone()) return done(new GuestGone());
        socket.send(encodeFrame(channel, chunk));
        void room(socket, gone).then(() => done());
      },
      final(done) {
        if (!gone()) socket.send(encodeFrame(channel, new Uint8Array(0)));
        done();
      },
      read() {},
      destroy(err, done) {
        if (forget() && !gone()) send({ type: "close", channel });
        done(err);
      },
    });
    this.sinks.set(channel, (data) => {
      if (data.byteLength === 0) stream.push(null);
      else stream.push(data);
    });
    // Closed from the other side: what came is read, then it ends, rather than being dropped.
    this.closers.set(channel, () => {
      stream.push(null);
      stream.end();
    });
    return stream;
  }

  private closeChannel(channel: number): void {
    const close = this.closers.get(channel);
    this.closers.delete(channel);
    this.sinks.delete(channel);
    close?.();
  }
}
