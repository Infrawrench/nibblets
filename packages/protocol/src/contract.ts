import { z } from "zod";
import {
  BankName,
  BankProviderId,
  BankSettings,
  BankStatus,
  Card,
  SpendingAllowance,
} from "./bank.ts";
import { CliStatuses, HostTools } from "./mcp.ts";
import { HarnessId, HarnessModels } from "./models.ts";
import { ConnectStatus, TailscaleStatus } from "./connect.ts";
import { OnePasswordGrants, OnePasswordStatus, VaultGrant } from "./onepassword.ts";
import { procedure } from "./rpc.ts";
import { Snapshot, SnapshotActivity, SnapshotTimeline } from "./snapshots.ts";
import { TailnetKeys } from "./tailscale.ts";
import { AppUpdate, HarnessUpdates } from "./updates.ts";
import { BudgetStatus } from "./budget.ts";
import {
  BackgroundTask,
  CreateNibblet,
  CreateSchedule,
  DesktopApp,
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
    /** Stops waiting out a usage limit and tries the queued work now. */
    resume: procedure(Id, Ok),
    /** Its monthly budget for API-key usage, and what it has spent this month. */
    spend: procedure(Id, BudgetStatus),
    /** Approves or declines a gated tool call the nibblet is waiting on. */
    decide: procedure(
      z.object({
        id: z.string(),
        approvalId: z.string(),
        approve: z.boolean(),
        reason: z.string().max(500).optional(),
      }),
      Ok,
    ),
    /** What it has running in the background, from `task_start`. Empty while it's asleep. */
    tasks: procedure(Id, z.array(BackgroundTask)),
    stopTask: procedure(z.object({ id: z.string(), taskId: z.string() }), Ok),
    /**
     * The desktop apps installed in its container, as last reported; asks
     * it to look again, and pushes what it finds as an `apps` live message.
     * Empty while it's asleep.
     */
    apps: procedure(Id, z.array(DesktopApp)),
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
    /** How nibblets without an auth key of their own get one; the client secret comes back masked. */
    keys: procedure(z.object({}), TailnetKeys),
    /** Sets (checking it with Tailscale first) or, with null, forgets the OAuth client. */
    setKeys: procedure(TailnetKeys, TailnetKeys),
  },
  hostTools: {
    /** The MCP servers on the host bridge, for ticking per nibblet. */
    list: procedure(z.object({}), HostTools),
  },
  updates: {
    /** The harnesses' CLIs: built in, installed since, and newest. */
    harnesses: procedure(z.object({}), HarnessUpdates),
    /** Looks for new releases now. */
    check: procedure(z.object({}), HarnessUpdates),
    /** Installs the newest release of one harness's CLI, or of all of them. */
    updateHarness: procedure(z.object({ id: HarnessId.optional() }), HarnessUpdates),
    /** Goes back to the CLI built into the runner image. */
    useBundled: procedure(z.object({ id: HarnessId }), HarnessUpdates),
    setAuto: procedure(z.object({ auto: z.boolean() }), HarnessUpdates),
    /** Whether a newer Nibblets is out. */
    app: procedure(z.object({ refresh: z.boolean().default(false) }), AppUpdate),
    /** Installs the newest Nibblets, where the host bridge can. */
    applyApp: procedure(z.object({}), AppUpdate),
  },
  clis: {
    /** Host CLIs and whether each is installed and signed in. */
    list: procedure(z.object({}), CliStatuses),
  },
  onePassword: {
    /** Whether 1Password is connected on the server's computer, and its vaults. */
    status: procedure(z.object({}), OnePasswordStatus),
    /** Which vaults each nibblet may use. */
    grants: procedure(z.object({}), OnePasswordGrants),
    /** Gives one nibblet exactly these vaults; an empty list takes them all away. */
    setGrants: procedure(
      z.object({ nibbletId: z.string(), grants: z.array(VaultGrant) }),
      OnePasswordGrants,
    ),
  },
  bank: {
    /** The bank plugins this server has set up, and what each has left to fund cards from. */
    status: procedure(z.object({}), BankStatus),
    /** A nibblet's cards, newest first, open and closed. */
    cards: procedure(z.object({ nibbletId: z.string() }), z.array(Card)),
    /** Where it stands against each of its spending limits. */
    allowances: procedure(z.object({ nibbletId: z.string() }), z.array(SpendingAllowance)),
    /** Kills a card for good. */
    kill: procedure(Id, Card),
    /**
     * Sets a bank up (with no `id`), or changes one, once its provider
     * answers to the settings. A secret given as `MASKED` keeps the one it has.
     */
    configure: procedure(
      z.object({
        id: BankProviderId.nullable(),
        kind: BankProviderId,
        name: BankName,
        settings: BankSettings,
      }),
      BankStatus,
    ),
    /** Forgets a bank's saved settings. Refused while it has cards that aren't closed. */
    remove: procedure(z.object({ id: BankProviderId }), BankStatus),
  },
  snapshots: {
    /** A nibblet's snapshots, newest first, and where it stands among them. */
    list: procedure(z.object({ nibbletId: z.string() }), SnapshotTimeline),
    /** Takes a snapshot now; waits for a turn in progress to finish first. */
    create: procedure(
      z.object({ nibbletId: z.string(), label: z.string().max(80).optional() }),
      Snapshot,
    ),
    /**
     * Puts the nibblet back (or forward) to a snapshot. Its current state is
     * snapshotted first, so the restore can itself be undone.
     */
    restore: procedure(Id, Ok),
    rename: procedure(z.object({ id: z.string(), label: z.string().max(80).nullable() }), Snapshot),
    delete: procedure(Id, Ok),
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
  /** Its background tasks, whenever one starts or ends (empty when its container's gone). */
  z.object({ type: z.literal("tasks"), nibbletId: z.string(), tasks: z.array(BackgroundTask) }),
  /** The desktop apps installed in its container, whenever they change. */
  z.object({ type: z.literal("apps"), nibbletId: z.string(), apps: z.array(DesktopApp) }),
  /** The thread was replaced (a snapshot was restored): drop it and fetch again from the start. */
  z.object({ type: z.literal("thread_reset"), nibbletId: z.string() }),
  /** One of its cards was made, killed, or spent on. */
  z.object({ type: z.literal("cards_changed"), nibbletId: z.string() }),
  /** A bank was set up, changed, or removed. */
  z.object({ type: z.literal("bank_changed") }),
  z.object({
    type: z.literal("snapshots_changed"),
    nibbletId: z.string(),
    activity: SnapshotActivity,
  }),
]);
export type LiveMessage = z.infer<typeof LiveMessage>;

const TerminalSize = { cols: z.int().min(1).max(1000), rows: z.int().min(1).max(1000) };

/**
 * What the browser sends over a terminal's WebSocket, at
 * `/api/nibblets/:id/terminal?cols=&rows=[&task=]`.
 */
export const TerminalInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(65_536) }),
  z.object({ type: z.literal("resize"), ...TerminalSize }),
  /** How much output it has drawn since the last ack, so more can come. */
  z.object({ type: z.literal("ack"), chars: z.int().min(0) }),
]);
export type TerminalInput = z.infer<typeof TerminalInput>;

/** What comes back. The socket closes after `exit` or `error`. */
export const TerminalEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), code: z.int().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type TerminalEvent = z.infer<typeof TerminalEvent>;
