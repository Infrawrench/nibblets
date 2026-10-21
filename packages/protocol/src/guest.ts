import { z } from "zod";
import { GuestOs } from "./machines.ts";

/**
 * How the server reaches inside a nibblet's virtual machine: a daemon in
 * the guest (the guest agent, run as root, or SYSTEM, from boot) on a
 * virtual serial port of its own, which only it and the hypervisor can open.
 * The hypervisor plugin hands the host end to the host bridge, which
 * relays it to the server over a WebSocket the server opens
 * (`/machines/:hv/vms/:id/link`), so the port is the only way in or out:
 * the guest needs no route to the host, and nothing in it needs a key.
 *
 * Over it the agent does what `docker exec` does for a container: runs
 * the nibblet's entry and its sub-agents' with the environment the server
 * gives it, signals them, and opens connections to ports inside the guest
 * for the server (the browser's view). The other way, it listens on the
 * guest's loopback for the server and the credential proxy (`server` and
 * `credproxy` in its hosts file), and each connection the runner makes
 * there goes out over the port, for the bridge to make on the host.
 *
 * On the WebSocket, control messages are JSON text frames and bytes (a
 * process's stdio, a connection's data) are binary frames: a 4-byte
 * big-endian channel id, then the data. On the serial port, both go in
 * `SerialFrame`s. An empty data frame ends the channel in that direction.
 *
 * Channel ids come from two ranges, so they never collide: the server's
 * from 1, and the guest's own connections from `GUEST_CHANNELS`.
 */

/** Where channels the guest opens start. */
export const GUEST_CHANNELS = 0x8000_0000;

/** The name the serial port has in the guest, where the hypervisor can name it. */
export const GUEST_PORT_NAME = "dev.nibblets.agent";

/**
 * On Hyper-V, the agent's port is a Hyper-V socket rather than a COM port:
 * the guest listens on this vsock port, and the host connects to it by the
 * service id Hyper-V gives a Linux vsock port (hypervServiceId).
 */
export const HYPERV_AGENT_PORT = 0x4e42;

/** The vsock port the host listens on for a guest's agent under Apple Virtualization. */
export const APPLE_AGENT_VSOCK_PORT = 1024;

/** The Hyper-V service id for a Linux guest's vsock port, as hv_sock maps them. */
export function hypervServiceId(port: number): string {
  return `${port.toString(16).padStart(8, "0")}-facb-11e6-bd58-64006a7986d3`;
}

/** Run ids the server uses for the processes it adopts again after a restart. */
export const MAIN_RUN = "main";
export const subagentRun = (nibbletId: string): string => `subagent:${nibbletId}`;

export const GuestSignal = z.enum(["SIGTERM", "SIGKILL", "SIGINT"]);
export type GuestSignal = z.infer<typeof GuestSignal>;

const Channel = z.int().min(1).max(0xffff_ffff);

/**
 * What a nibblet's entry does, inside its machine: `main` is the nibblet
 * itself (the guard, the runner, Tailscale); the rest are what the server
 * would otherwise do to a container from outside. `archive-home` writes the
 * home folder to stdout as a gzipped tar without its caches, and
 * `restore-home` replaces it with one from stdin.
 */
export const EntryCommand = z.enum([
  "main",
  "subagent",
  "tailscale-leave",
  "stop-subagent",
  "remove-subagent",
  "archive-home",
  "restore-home",
  // Windows only: installs and activates the product key it's given on stdin.
  "product-key",
]);
export type EntryCommand = z.infer<typeof EntryCommand>;

/** The host services a guest may connect to, through the port. */
export const GuestTarget = z.enum(["server", "credproxy"]);
export type GuestTarget = z.infer<typeof GuestTarget>;

export const ServerToGuest = z.discriminatedUnion("type", [
  /**
   * Asks it to say `hello` again: sent whenever the server's side connects.
   * Channels the server opened (from 1) are gone with the server's last
   * link, so it closes them, and stops sending runs' output anywhere: unless
   * `link` is the one it last heard from, which may ask more than once.
   */
  z.object({ type: z.literal("hello"), link: z.string().max(64).optional() }),
  /** The host's end of the port is new: every channel is gone, the guest's own too. */
  z.object({ type: z.literal("reset") }),
  /**
   * Runs the guest's nibblet entry as root (SYSTEM on Windows) with one of
   * its commands, the way a container's entry is run: the agent knows
   * where it lives on its OS, so the server never needs to. A channel
   * that's null is dropped (stdin is closed). `run` names it: a second run
   * with a name that's still running is refused.
   */
  z.object({
    type: z.literal("run"),
    run: z.string().min(1).max(200),
    command: EntryCommand,
    /** For `stop-subagent` and `remove-subagent`: whose. */
    args: z.array(z.string().regex(/^[\w-]+$/)).max(4),
    env: z.record(z.string(), z.string()),
    stdin: Channel.nullable(),
    stdout: Channel.nullable(),
    stderr: Channel.nullable(),
  }),
  z.object({ type: z.literal("signal"), run: z.string(), signal: GuestSignal }),
  /** The last of a run's output, which the agent keeps for each one. */
  z.object({ type: z.literal("tail"), request: z.string(), run: z.string() }),
  /** Opens a connection to a port on the guest's loopback. */
  z.object({ type: z.literal("open"), channel: Channel, port: z.int().min(1).max(65535) }),
  /** Drops a channel both ways. */
  z.object({ type: z.literal("close"), channel: Channel }),
  /** The answer to the guest's `connect`, from the bridge. */
  z.object({ type: z.literal("connected"), channel: Channel }),
  z.object({ type: z.literal("connect_failed"), channel: Channel, error: z.string() }),
  /** Shuts the guest down, the way its own power button would. */
  z.object({ type: z.literal("poweroff") }),
]);
export type ServerToGuest = z.infer<typeof ServerToGuest>;

export const RunExitInfo = z.object({
  run: z.string(),
  code: z.int().nullable(),
  signal: z.string().nullable(),
  /** Why it never started, when it didn't. */
  error: z.string().nullable(),
});
export type RunExitInfo = z.infer<typeof RunExitInfo>;

export const GuestToServer = z.discriminatedUnion("type", [
  /**
   * When it starts, and whenever it's asked: what it is, what it has
   * running, and how the last few runs ended, in case nobody was listening.
   */
  z.object({
    type: z.literal("hello"),
    os: GuestOs,
    version: z.string(),
    runs: z.array(z.object({ run: z.string(), pid: z.int() })),
    exited: z.array(RunExitInfo),
    /** The link that asked, if one did. */
    link: z.string().max(64).optional(),
    /**
     * This agent, and how many times it's let go of channels: a link that
     * hears it unchanged has lost none since it last heard it.
     */
    epoch: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal("started"), run: z.string(), pid: z.int() }),
  RunExitInfo.extend({ type: z.literal("exited") }),
  z.object({ type: z.literal("tail"), request: z.string(), text: z.string() }),
  z.object({ type: z.literal("opened"), channel: Channel }),
  z.object({ type: z.literal("open_failed"), channel: Channel, error: z.string() }),
  z.object({ type: z.literal("closed"), channel: Channel }),
  /** A connection the runner made to a host service, on a channel from `GUEST_CHANNELS`. */
  z.object({ type: z.literal("connect"), channel: Channel, target: GuestTarget }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type GuestToServer = z.infer<typeof GuestToServer>;

/** A binary WebSocket frame: the channel, then the bytes. */
export function encodeFrame(channel: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + data.byteLength);
  new DataView(frame.buffer).setUint32(0, channel);
  frame.set(data, 4);
  return frame;
}

export function decodeFrame(frame: Uint8Array): { channel: number; data: Uint8Array } | null {
  if (frame.byteLength < 4) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { channel: view.getUint32(0), data: frame.subarray(4) };
}

/**
 * On the serial port, everything goes in frames: two magic bytes, a kind
 * (0 for a JSON message, 1 for channel data, laid out as on the
 * WebSocket), a 4-byte big-endian length, then that many bytes. A port
 * is a bare stream that someone may join halfway through a frame (the
 * bridge restarting, say), so a reader that loses its place skips ahead to
 * the next magic, and no frame is ever longer than `MAX_SERIAL_FRAME`.
 */
export type SerialFrame = { kind: "message"; text: string } | { kind: "data"; frame: Uint8Array };

const MAGIC_0 = 0x4e;
const MAGIC_1 = 0x42;
const HEADER = 7;
export const MAX_SERIAL_FRAME = 1024 * 1024;
/** How much of a channel's data goes in one frame. */
export const SERIAL_CHUNK = 64 * 1024;

export function encodeSerial(frame: SerialFrame): Uint8Array {
  const body = frame.kind === "message" ? new TextEncoder().encode(frame.text) : frame.frame;
  if (body.byteLength > MAX_SERIAL_FRAME) throw new Error("serial frame too long");
  const out = new Uint8Array(HEADER + body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC_0);
  view.setUint8(1, MAGIC_1);
  view.setUint8(2, frame.kind === "message" ? 0 : 1);
  view.setUint32(3, body.byteLength);
  out.set(body, HEADER);
  return out;
}

/** Reads `SerialFrame`s out of a byte stream, however it's chunked. */
export class SerialReader {
  private buffer = new Uint8Array(0);
  private readonly decoder = new TextDecoder();

  /** Feeds in bytes; returns the frames now complete. */
  push(chunk: Uint8Array): SerialFrame[] {
    const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.byteLength);
    const frames: SerialFrame[] = [];
    let at = 0;
    while (joined.byteLength - at >= HEADER) {
      const view = new DataView(joined.buffer, at);
      const kind = view.getUint8(2);
      const length = view.getUint32(3);
      if (
        view.getUint8(0) !== MAGIC_0 ||
        view.getUint8(1) !== MAGIC_1 ||
        kind > 1 ||
        length > MAX_SERIAL_FRAME
      ) {
        // Lost: on to the next byte that could start a frame.
        at++;
        continue;
      }
      if (joined.byteLength - at < HEADER + length) break;
      const body = joined.slice(at + HEADER, at + HEADER + length);
      frames.push(
        kind === 0
          ? { kind: "message", text: this.decoder.decode(body) }
          : { kind: "data", frame: body },
      );
      at += HEADER + length;
    }
    this.buffer = joined.slice(at);
    return frames;
  }
}
