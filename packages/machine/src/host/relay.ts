import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  decodeFrame,
  encodeFrame,
  encodeSerial,
  GUEST_CHANNELS,
  GuestToServer,
  SERIAL_CHUNK,
  SerialReader,
  type GuestTarget,
  type ServerToGuest,
} from "@nibblet/protocol";
import type { GuestSocket } from "../guest-link.ts";

/** Where on the host the guest's connections go. */
export type RelayTargets = Record<GuestTarget, { host: string; port: number }>;

/** `http://127.0.0.1:8420` as a host and port. */
export function target(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)) };
}

/**
 * One VM's agent port, relayed. The guest's end is a byte stream of
 * `SerialFrame`s from the hypervisor plugin; the server's is a WebSocket,
 * which comes and goes as the server does. Everything passes between them
 * as it is, except the guest's own connections (`connect`, on channels
 * from `GUEST_CHANNELS`), which the relay makes here on the host: to the
 * server and the credential proxy, as the host reaches them.
 */
export class GuestRelay {
  private readonly targets: RelayTargets;
  private readonly log: (message: string) => void;
  private port: Duplex | null = null;
  private reader = new SerialReader();
  private server: GuestSocket | null = null;
  /** The guest's connections, by channel. */
  private readonly sockets = new Map<number, Socket>();
  private closed = false;

  constructor(targets: RelayTargets, log: (message: string) => void) {
    this.targets = targets;
    this.log = log;
  }

  /** Its port, connected (or again, after it dropped). */
  attachPort(port: Duplex): void {
    // A connection made for a relay that's gone since: to the guest, it would be the host's newest.
    if (this.closed) {
      port.destroy();
      return;
    }
    this.dropPort();
    this.port = port;
    this.reader = new SerialReader();
    port.on("data", (chunk: Buffer) => {
      for (const frame of this.reader.push(chunk)) {
        if (frame.kind === "message") this.fromGuest(frame.text);
        else this.dataFromGuest(frame.frame);
      }
    });
    const gone = (err?: Error) => {
      if (this.port !== port) return;
      if (!this.closed) this.log(`its agent's port closed${err ? `: ${err.message}` : ""}`);
      this.dropPort();
    };
    port.once("close", () => gone());
    port.once("error", gone);
    // Whatever either end thought was open is gone with the last port.
    this.toGuest({ type: "reset" });
    if (this.server) this.toGuest({ type: "hello" });
  }

  get connected(): boolean {
    return this.port !== null;
  }

  private dropPort(): void {
    const port = this.port;
    this.port = null;
    port?.destroy();
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
  }

  /** The server's link: replaces any before it. */
  attachServer(socket: GuestSocket): void {
    const previous = this.server;
    this.server = socket;
    previous?.close();
    socket.onMessage((data) => {
      let room = true;
      if (typeof data === "string") {
        room = this.writePort(encodeSerial({ kind: "message", text: data }));
      } else {
        const frame = decodeFrame(data);
        if (!frame) return;
        for (const piece of chunks(frame.data)) {
          room = this.writePort(
            encodeSerial({ kind: "data", frame: encodeFrame(frame.channel, piece) }),
          );
        }
      }
      // The guest's port is slower than the server (Hyper-V's COM port, most
      // of all): hold the server back rather than keep what it sends here.
      if (!room && this.port && socket.pause) {
        socket.pause();
        this.port.once("drain", () => socket.resume?.());
      }
    });
    socket.onClose(() => {
      if (this.server === socket) this.server = null;
    });
    // No hello of its own: the link says one as it opens, and the guest
    // answers each. A second answer, once the link's started a run, reads
    // as the port starting afresh, and cuts the run off.
  }

  close(): void {
    this.closed = true;
    this.server?.close();
    this.server = null;
    this.dropPort();
  }

  private writePort(bytes: Uint8Array): boolean {
    if (!this.port || this.closed) return false;
    return this.port.write(bytes);
  }

  private toGuest(msg: ServerToGuest): void {
    this.writePort(encodeSerial({ kind: "message", text: JSON.stringify(msg) }));
  }

  private fromGuest(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = GuestToServer.safeParse(raw);
    if (parsed.success && parsed.data.type === "connect") {
      this.connectFor(parsed.data.channel, parsed.data.target);
      return;
    }
    if (parsed.success && parsed.data.type === "closed" && parsed.data.channel >= GUEST_CHANNELS) {
      // What's still on its way out is sent first.
      this.sockets.get(parsed.data.channel)?.destroySoon();
      this.sockets.delete(parsed.data.channel);
      return;
    }
    this.server?.send(text);
  }

  private dataFromGuest(raw: Uint8Array): void {
    const frame = decodeFrame(raw);
    if (!frame) return;
    if (frame.channel < GUEST_CHANNELS) {
      this.server?.send(raw);
      return;
    }
    const socket = this.sockets.get(frame.channel);
    if (!socket) return;
    if (frame.data.byteLength === 0) socket.end();
    else if (!socket.write(frame.data) && this.port && !this.port.isPaused()) {
      // The host's side is slow: hold the guest back (its port is a stream, so this backs it up).
      const port = this.port;
      port.pause();
      socket.once("drain", () => port.resume());
    }
  }

  /** A connection the guest asked for, made here and spliced into the port. */
  private connectFor(channel: number, name: GuestTarget): void {
    const { host, port } = this.targets[name];
    const socket = connect({ host, port });
    this.sockets.set(channel, socket);
    let open = false;
    socket.once("connect", () => {
      open = true;
      this.toGuest({ type: "connected", channel });
    });
    socket.on("data", (chunk: Buffer) => {
      let full = false;
      for (const piece of chunks(chunk)) {
        full = !this.writePort(encodeSerial({ kind: "data", frame: encodeFrame(channel, piece) }));
      }
      if (full && this.port) {
        socket.pause();
        this.port.once("drain", () => socket.resume());
      }
    });
    socket.once("end", () => {
      this.writePort(
        encodeSerial({ kind: "data", frame: encodeFrame(channel, new Uint8Array(0)) }),
      );
    });
    socket.once("error", (err) => {
      if (!open) {
        this.toGuest({ type: "connect_failed", channel, error: err.message });
        this.log(`couldn't reach the ${name} for a guest at ${host}:${port}: ${err.message}`);
      }
    });
    socket.once("close", () => {
      if (this.sockets.get(channel) !== socket) return;
      this.sockets.delete(channel);
      if (open) this.toGuest({ type: "close", channel });
    });
  }
}

/** Bytes cut into pieces that fit a serial frame. */
function* chunks(data: Uint8Array): Generator<Uint8Array> {
  if (data.byteLength === 0) {
    yield data;
    return;
  }
  for (let at = 0; at < data.byteLength; at += SERIAL_CHUNK) {
    yield data.subarray(at, at + SERIAL_CHUNK);
  }
}
