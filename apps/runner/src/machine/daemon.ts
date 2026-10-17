import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Duplex, Readable } from "node:stream";
import {
  decodeFrame,
  encodeFrame,
  encodeSerial,
  GUEST_CHANNELS,
  SERIAL_CHUNK,
  GuestTarget,
  SerialReader,
  ServerToGuest,
  type GuestToServer,
  type RunExitInfo,
} from "@nibblet/protocol";
import type { GuestPlugin } from "./guest.ts";

/** How much of each run's output is kept, for `tail`. */
const TAIL_CHARS = 16_000;
/** How many finished runs keep their tail and their exit, for whoever asks late. */
const KEEP_FINISHED = 50;

interface Run {
  child: ChildProcess;
  tail: string;
  /** The server's channels for its output, while it has a link to hear them. */
  stdout: number | null;
  stderr: number | null;
}

/** Bytes cut into pieces that fit a serial frame. */
function* chunks(data: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < data.byteLength; at += SERIAL_CHUNK) {
    yield data.subarray(at, at + SERIAL_CHUNK);
  }
}

export interface DaemonOptions {
  guest: GuestPlugin;
  version: string;
  /** Where the runner's connections to the host's services are listened for, in the guest. */
  listen: Record<GuestTarget, { host: string; port: number }>;
  /** The guest's agent environment, merged under what the server sends. */
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/**
 * The guest agent's work, over its port: the server's runs and
 * connections into the guest, and the runner's connections out to the
 * host's services. See protocol's guest.ts for what goes over it.
 */
export class GuestDaemon {
  private readonly opts: DaemonOptions;
  private readonly log: (message: string) => void;
  private port: Duplex | null = null;
  private reader = new SerialReader();
  private readonly runs = new Map<string, Run>();
  /** Finished runs' tails and exits, newest last. */
  private readonly finished: { exit: RunExitInfo; tail: string }[] = [];
  /** Where each channel's incoming bytes go, and how to drop it. */
  private readonly channels = new Map<number, { write(data: Uint8Array): void; drop(): void }>();
  private readonly listeners: Server[] = [];
  private nextChannel = GUEST_CHANNELS;
  /** Connections waiting for the bridge to say it's made theirs. */
  private readonly connecting = new Map<number, Socket>();

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(`agent: ${m}`));
  }

  /**
   * Listens for the runner's connections to the host, so they go out over
   * the port. Returns the ports it's listening on (0 asks for any).
   */
  async listen(): Promise<Record<GuestTarget, number>> {
    const ports: Record<GuestTarget, number> = { server: 0, credproxy: 0 };
    for (const target of GuestTarget.options) {
      const { host, port } = this.opts.listen[target];
      const server = createServer((socket) => this.outgoing(socket, target));
      ports[target] = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const a = server.address();
          resolve(typeof a === "object" && a ? a.port : port);
        });
      });
      this.listeners.push(server);
    }
    return ports;
  }

  /** Talks over `port` from now on, saying hello. */
  attach(port: Duplex): void {
    this.port = port;
    this.reader = new SerialReader();
    let heard = false;
    port.on("data", (chunk: Buffer) => {
      if (!heard) {
        heard = true;
        this.log("the host's end of the port is talking");
      }
      for (const frame of this.reader.push(chunk)) {
        if (frame.kind === "message") this.receive(frame.text);
        else this.data(frame.frame);
      }
    });
    port.once("close", () => {
      if (this.port === port) this.port = null;
      this.dropChannels(() => true);
    });
    this.hello();
    port.on("error", (err) => this.log(`the port failed: ${err.message}`));
  }

  close(): void {
    for (const server of this.listeners) server.close();
    this.dropChannels(() => true);
  }

  private write(bytes: Uint8Array): boolean {
    return this.port?.write(bytes) ?? false;
  }

  private send(msg: GuestToServer): void {
    this.write(encodeSerial({ kind: "message", text: JSON.stringify(msg) }));
  }

  /** Data out on `channel`, holding `source` back while the port is full. */
  private sendData(channel: number, chunk: Uint8Array, source?: Readable): void {
    let full = false;
    for (const piece of chunks(chunk)) {
      full = !this.write(encodeSerial({ kind: "data", frame: encodeFrame(channel, piece) }));
    }
    if (full && source && this.port) {
      source.pause();
      this.port.once("drain", () => source.resume());
    }
  }

  private sendEnd(channel: number): void {
    this.write(encodeSerial({ kind: "data", frame: encodeFrame(channel, new Uint8Array(0)) }));
  }

  private hello(): void {
    this.send({
      type: "hello",
      os: this.opts.guest.os,
      version: this.opts.version,
      runs: [...this.runs].map(([run, r]) => ({ run, pid: r.child.pid ?? 0 })),
      exited: this.finished.map((f) => f.exit),
    });
  }

  /** Drops channels, and runs' output to them; `which` picks them by id. */
  private dropChannels(which: (channel: number) => boolean): void {
    for (const [channel, c] of [...this.channels]) {
      if (!which(channel)) continue;
      this.channels.delete(channel);
      c.drop();
    }
    for (const socket of this.connecting.values()) socket.destroy();
    this.connecting.clear();
    for (const run of this.runs.values()) {
      if (run.stdout !== null && which(run.stdout)) run.stdout = null;
      if (run.stderr !== null && which(run.stderr)) run.stderr = null;
    }
  }

  private receive(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = ServerToGuest.safeParse(raw);
    if (!parsed.success) {
      this.log(`didn't understand: ${text.slice(0, 200)}`);
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        // A new link from the server: what it opened before is gone with it.
        this.dropChannels((channel) => channel < GUEST_CHANNELS);
        this.hello();
        return;
      case "reset":
        this.dropChannels(() => true);
        return;
      case "run":
        this.run(msg);
        return;
      case "signal": {
        const run = this.runs.get(msg.run);
        run?.child.kill(msg.signal);
        return;
      }
      case "tail": {
        const text =
          this.runs.get(msg.run)?.tail ??
          this.finished.findLast((f) => f.exit.run === msg.run)?.tail ??
          "";
        this.send({ type: "tail", request: msg.request, text });
        return;
      }
      case "open":
        this.open(msg.channel, msg.port);
        return;
      case "close":
        this.channels.get(msg.channel)?.drop();
        this.channels.delete(msg.channel);
        return;
      case "connected": {
        const socket = this.connecting.get(msg.channel);
        this.connecting.delete(msg.channel);
        if (socket) this.splice(msg.channel, socket);
        return;
      }
      case "connect_failed":
        this.connecting.get(msg.channel)?.destroy();
        this.connecting.delete(msg.channel);
        this.log(`the host couldn't make a connection: ${msg.error}`);
        return;
      case "poweroff":
        this.log("powering off, as asked");
        void this.opts.guest
          .poweroff()
          .catch((err: unknown) => this.log(`couldn't: ${String(err)}`));
        return;
    }
  }

  private data(raw: Uint8Array): void {
    const frame = decodeFrame(raw);
    if (frame) this.channels.get(frame.channel)?.write(frame.data);
  }

  private run(msg: Extract<ServerToGuest, { type: "run" }>): void {
    if (this.runs.has(msg.run)) {
      this.send({
        type: "exited",
        run: msg.run,
        code: null,
        signal: null,
        error: `${msg.run} is already running`,
      });
      return;
    }
    const { file, argv } = this.opts.guest.entry(msg.command, msg.args);
    let child: ChildProcess;
    try {
      child = spawn(file, argv, {
        // NIBBLET_IN_VM: the entry fences a VM's processes in itself, as Docker does a container's.
        env: { ...(this.opts.env ?? process.env), ...msg.env, NIBBLET_IN_VM: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.finish(msg.run, { code: null, signal: null, error: String(err) }, "");
      return;
    }
    const run: Run = { child, tail: "", stdout: msg.stdout, stderr: msg.stderr };
    this.runs.set(msg.run, run);
    const output = (stream: Readable | null, which: "stdout" | "stderr") => {
      stream?.on("data", (chunk: Buffer) => {
        run.tail = (run.tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
        const channel = run[which];
        if (channel !== null) this.sendData(channel, chunk, stream);
        // The nibblet's own output goes to the journal (and the console) too.
        if (msg.command === "main") process[which].write(chunk);
      });
    };
    output(child.stdout, "stdout");
    output(child.stderr, "stderr");
    if (msg.stdin === null) child.stdin?.end();
    else if (child.stdin) {
      const stdin = child.stdin;
      this.channels.set(msg.stdin, {
        write: (data) => {
          if (data.byteLength === 0) stdin.end();
          else if (!stdin.write(data) && this.port && !this.port.isPaused()) {
            const port = this.port;
            port.pause();
            stdin.once("drain", () => port.resume());
          }
        },
        drop: () => stdin.end(),
      });
      // A process that stops reading early isn't an error worth dying over.
      stdin.on("error", () => {});
    }
    let ended = false;
    const end = (exit: Omit<RunExitInfo, "run">) => {
      if (ended) return;
      ended = true;
      // Its output first, so the server has it all before it hears it's over.
      const flush = (which: "stdout" | "stderr") => {
        const channel = run[which];
        if (channel !== null) this.sendEnd(channel);
      };
      flush("stdout");
      flush("stderr");
      if (msg.stdin !== null) this.channels.delete(msg.stdin);
      this.runs.delete(msg.run);
      void (this.opts.guest.afterRun?.(msg.command) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => this.finish(msg.run, exit, run.tail));
    };
    child.once("spawn", () => this.send({ type: "started", run: msg.run, pid: child.pid ?? 0 }));
    child.once("error", (err) => end({ code: null, signal: null, error: err.message }));
    child.once("close", (code, signal) => end({ code, signal, error: null }));
  }

  private finish(run: string, exit: Omit<RunExitInfo, "run">, tail: string): void {
    const info = { run, ...exit };
    this.finished.push({ exit: info, tail });
    if (this.finished.length > KEEP_FINISHED)
      this.finished.splice(0, this.finished.length - KEEP_FINISHED);
    this.send({ type: "exited", ...info });
  }

  /** The server's connection to a port on the guest's loopback. */
  private open(channel: number, port: number): void {
    const socket = connect({ host: "127.0.0.1", port });
    let opened = false;
    socket.once("connect", () => {
      opened = true;
      this.send({ type: "opened", channel });
      this.splice(channel, socket);
    });
    socket.once("error", (err) => {
      if (!opened) this.send({ type: "open_failed", channel, error: err.message });
    });
  }

  /** One the runner made to the host: out over the port once the bridge has made it there. */
  private outgoing(socket: Socket, target: GuestTarget): void {
    if (!this.port) {
      socket.destroy();
      return;
    }
    const channel = this.nextChannel++;
    if (this.nextChannel > 0xffff_fff0) this.nextChannel = GUEST_CHANNELS;
    socket.pause();
    this.connecting.set(channel, socket);
    socket.once("error", () => socket.destroy());
    this.send({ type: "connect", channel, target });
  }

  /** A socket and a channel, joined both ways. */
  private splice(channel: number, socket: Socket): void {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.channels.delete(channel);
      socket.destroy();
      this.send({ type: "closed", channel });
    };
    this.channels.set(channel, {
      write: (data) => {
        if (data.byteLength === 0) socket.end();
        else if (!socket.write(data) && this.port && !this.port.isPaused()) {
          const port = this.port;
          port.pause();
          socket.once("drain", () => port.resume());
        }
      },
      drop: () => {
        closed = true;
        // What's still on its way out is sent first.
        socket.destroySoon();
      },
    });
    socket.on("data", (chunk: Buffer) => this.sendData(channel, chunk, socket));
    socket.once("end", () => this.sendEnd(channel));
    socket.once("close", close);
    socket.once("error", close);
    socket.resume();
  }
}
