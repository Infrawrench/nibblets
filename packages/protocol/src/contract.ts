import { z } from "zod";
import { CliStatuses, HostTools } from "./mcp.ts";
import { HarnessId, HarnessModels } from "./models.ts";
import { ConnectStatus, TailscaleStatus } from "./connect.ts";
import { procedure } from "./rpc.ts";
import {
  CreateNibblet,
  CreateSchedule,
  Memory,
  Nibblet,
  Schedule,
  ServerInfo,
  StoredItem,
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
    /** `attachments` are file ids from `POST /api/nibblets/:id/files`. */
    send: procedure(
      z
        .object({
          id: z.string(),
          text: z.string(),
          attachments: z.array(z.string()).max(20).default([]),
        })
        .refine((m) => m.text.trim().length > 0 || m.attachments.length > 0, {
          message: "Send some text or a file",
        }),
      Ok,
    ),
    interrupt: procedure(Id, Ok),
    /** Runs the heartbeat now rather than waiting for the next one. */
    wake: procedure(Id, Ok),
  },
  harnesses: {
    /** A harness's models: the fixed lists for Claude and Codex, the host's live list for OpenCode. */
    models: procedure(z.object({ harness: HarnessId }), HarnessModels),
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
  connect: {
    /** This server's link to a Nibblets account on the central service. */
    status: procedure(z.object({}), ConnectStatus),
    /** Starts linking: returns a code to approve on the central site. */
    start: procedure(z.object({}), ConnectStatus),
    /** Abandons a link that hasn't been approved. */
    cancel: procedure(z.object({}), ConnectStatus),
    /** Forgets the account and stops the tunnel. */
    unlink: procedure(z.object({}), ConnectStatus),
  },
  tailscale: {
    status: procedure(z.object({}), TailscaleStatus),
    /** Shares this server on the tailnet with `tailscale serve`, or stops. */
    set: procedure(z.object({ serving: z.boolean() }), TailscaleStatus),
    /** Starts signing this computer in to Tailscale; the status carries the link to finish it. */
    login: procedure(z.object({}), TailscaleStatus),
  },
  hostTools: {
    /** The MCP servers on the host bridge, for ticking per nibblet. */
    list: procedure(z.object({}), HostTools),
  },
  clis: {
    /** Host CLIs and whether each is installed and signed in. */
    list: procedure(z.object({}), CliStatuses),
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
