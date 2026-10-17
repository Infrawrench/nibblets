import { z } from "zod";
import { GuestOs } from "./machines.ts";

/**
 * The link between the server and the guest agent inside a nibblet's
 * virtual machine, a WebSocket at `/machine`. The agent runs as root (or
 * SYSTEM) from the moment the guest boots, dials out, and does what `docker
 * exec` does for a container: starts the nibblet's entry and its
 * sub-agents' with the environment the server gives it, signals them, and
 * opens connections to ports inside the guest for the server (the browser's
 * view). Nothing else in the guest reaches the server this way.
 *
 * Control messages are JSON text frames. Bytes (a process's stdin, stdout
 * and stderr, and opened connections) are binary frames: a 4-byte
 * big-endian channel id, then the data. An empty frame ends the channel in
 * that direction.
 *
 * It authenticates with `Authorization: Bearer <key>` and
 * `?nibblet=<id>&boot=<boot>`: the enrolment key from the guest's config
 * disk the first time, good once, and the session key `welcome` gives it
 * for reconnecting after that.
 */

/** What the hypervisor plugin puts on the guest's config disk, as `nibblet.json`. */
export const GuestConfig = z.object({
  nibbletId: z.string(),
  /** Made afresh each time the machine starts; the key is only good for this boot. */
  boot: z.string(),
  key: z.string(),
  /** The server's `/machine` socket, by the names the guest maps to its gateway. */
  server: z.string(),
  /** Names the agent points at the host's address on the machine's network. */
  hosts: z.array(z.string()),
  /** The Nibblets release the server runs, for guests that install the runner themselves. */
  version: z.string(),
  /** Where that release's source comes from, as `owner/repo` on GitHub. */
  repo: z.string(),
});
export type GuestConfig = z.infer<typeof GuestConfig>;

/** The volume label of the config disk, and the file on it. */
export const GUEST_CONFIG_LABEL = "NIBBLET";
export const GUEST_CONFIG_FILE = "nibblet.json";

/** Run ids the server uses for the processes it adopts again after a restart. */
export const MAIN_RUN = "main";
export const subagentRun = (nibbletId: string): string => `subagent:${nibbletId}`;

export const GuestSignal = z.enum(["SIGTERM", "SIGKILL", "SIGINT"]);
export type GuestSignal = z.infer<typeof GuestSignal>;

const Channel = z.int().min(1).max(0xffff_ffff);

export const ServerToGuest = z.discriminatedUnion("type", [
  /** Sent once the agent connects: the key to reconnect with. */
  z.object({ type: z.literal("welcome"), session: z.string() }),
  /**
   * Starts a process as root (SYSTEM on Windows). A channel that's null is
   * dropped (stdin is closed). `run` names it: a second run with a name
   * that's still running replaces nothing, and is refused.
   */
  z.object({
    type: z.literal("run"),
    run: z.string().min(1).max(200),
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()),
    cwd: z.string().nullable(),
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
  /** Shuts the guest down, the way its own power button would. */
  z.object({ type: z.literal("poweroff") }),
]);
export type ServerToGuest = z.infer<typeof ServerToGuest>;

export const GuestRunInfo = z.object({ run: z.string(), pid: z.int() });

export const GuestToServer = z.discriminatedUnion("type", [
  /** First, on every connect: what it is, and what it still has running from before. */
  z.object({
    type: z.literal("hello"),
    os: GuestOs,
    version: z.string(),
    runs: z.array(GuestRunInfo),
  }),
  z.object({ type: z.literal("started"), run: z.string(), pid: z.int() }),
  z.object({
    type: z.literal("exited"),
    run: z.string(),
    code: z.int().nullable(),
    signal: z.string().nullable(),
    /** Why it never started, when it didn't. */
    error: z.string().nullable(),
  }),
  z.object({ type: z.literal("tail"), request: z.string(), text: z.string() }),
  z.object({ type: z.literal("opened"), channel: Channel }),
  z.object({ type: z.literal("open_failed"), channel: Channel, error: z.string() }),
  z.object({ type: z.literal("closed"), channel: Channel }),
  z.object({
    type: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
]);
export type GuestToServer = z.infer<typeof GuestToServer>;

/** A binary frame: the channel, then the bytes. */
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
