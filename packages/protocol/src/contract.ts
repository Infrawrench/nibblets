import { z } from "zod";
import { CliStatuses, HostTools } from "./mcp.ts";
import { procedure } from "./rpc.ts";
import {
  CreateNibblet,
  CreateSchedule,
  Memory,
  Nibblet,
  Peer,
  Schedule,
  ServerInfo,
  StoredItem,
  TunnelConfig,
  TunnelStatus,
  UpdateNibblet,
} from "./schema.ts";

const Id = z.object({ id: z.string() });
const Ok = z.object({ ok: z.literal(true) });

/** The API the web UI (and peer servers) call. Served at `/api/rpc`. */
export const contract = {
  system: {
    info: procedure(z.object({}), ServerInfo),
    rename: procedure(z.object({ name: z.string().min(1) }), Ok),
  },
  nibblets: {
    list: procedure(z.object({}), z.array(Nibblet)),
    get: procedure(Id, Nibblet),
    create: procedure(CreateNibblet, Nibblet),
    update: procedure(UpdateNibblet, Nibblet),
    delete: procedure(Id, Ok),
    start: procedure(Id, Nibblet),
    stop: procedure(Id, Nibblet),
    /** Sends a message. Queued if the nibblet is mid-turn. */
    send: procedure(z.object({ id: z.string(), text: z.string().min(1) }), Ok),
    interrupt: procedure(Id, Ok),
    /** Runs the heartbeat now rather than waiting for the next one. */
    wake: procedure(Id, Ok),
  },
  thread: {
    /** Items after `sinceSeq`, oldest first. Live updates come over `/api/live`. */
    items: procedure(
      z.object({ nibbletId: z.string(), sinceSeq: z.int().default(0) }),
      z.array(StoredItem),
    ),
  },
  schedules: {
    list: procedure(z.object({ nibbletId: z.string() }), z.array(Schedule)),
    create: procedure(CreateSchedule, Schedule),
    setEnabled: procedure(z.object({ id: z.string(), enabled: z.boolean() }), Schedule),
    delete: procedure(Id, Ok),
  },
  memories: {
    list: procedure(
      z.object({ nibbletId: z.string().nullable(), query: z.string().optional() }),
      z.array(Memory),
    ),
    create: procedure(
      z.object({
        nibbletId: z.string().nullable(),
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
      }),
      Memory,
    ),
    delete: procedure(Id, Ok),
  },
  tunnel: {
    status: procedure(z.object({}), TunnelStatus),
    configure: procedure(TunnelConfig, TunnelStatus),
  },
  hostTools: {
    /** The MCP servers on the host bridge, for ticking per nibblet. */
    list: procedure(z.object({}), HostTools),
  },
  clis: {
    /** Host CLIs and whether each is installed and signed in. */
    list: procedure(z.object({}), CliStatuses),
  },
  peers: {
    list: procedure(z.object({}), z.array(Peer)),
    /** Adds a server from a pairing link made on that server (`https://host/#pair=code`). */
    add: procedure(z.object({ link: z.url() }), Peer),
    remove: procedure(Id, Ok),
  },
  auth: {
    /** A one-time link another device opens to sign in to this server. */
    createPairingLink: procedure(
      z.object({}),
      z.object({ url: z.string(), expiresAt: z.string() }),
    ),
  },
};

export type Contract = typeof contract;

/** What the server pushes over the `/api/live` WebSocket. */
export const LiveMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nibblet"), nibblet: Nibblet }),
  z.object({ type: z.literal("nibblet_deleted"), id: z.string() }),
  z.object({ type: z.literal("item"), item: StoredItem }),
  z.object({ type: z.literal("schedules_changed"), nibbletId: z.string() }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;
