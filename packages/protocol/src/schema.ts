import { z } from "zod";
import { McpServerDef, McpServerList, ToolRules } from "./mcp.ts";
import { Effort, HarnessId } from "./models.ts";
import { SnapshotPolicy } from "./snapshots.ts";
import { NibbletTailscale, TailnetNode } from "./tailscale.ts";

const Timestamp = z.iso.datetime();

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

export const ActiveHours = z.object({
  /** 24-hour "HH:MM", local to `timezone`. */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string(),
});
export type ActiveHours = z.infer<typeof ActiveHours>;

export const HeartbeatName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes");

/**
 * One of a nibblet's regular check-ins. A nibblet keeps as many as it needs
 * (the inbox every 15 minutes in working hours, the deploys hourly) and sets
 * them itself with the `heartbeat_*` tools.
 */
export const Heartbeat = z.object({
  name: HeartbeatName,
  everyMinutes: z
    .int()
    .min(5)
    .max(24 * 60),
  activeHours: ActiveHours.nullable(),
  /** What to look at each time it fires. */
  checklist: z.string(),
  lastRunAt: z.iso.datetime().nullable(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const MAX_HEARTBEATS = 10;

/** Where an ear can be pierced, on either side: the rim, higher up it, the lobe, the bowl. */
export const EarPiercing = z.enum([
  "left-helix",
  "left-upper",
  "left-lobe",
  "left-conch",
  "right-helix",
  "right-upper",
  "right-lobe",
  "right-conch",
]);
export type EarPiercing = z.infer<typeof EarPiercing>;

export const NosePiercing = z.enum(["none", "left-stud", "right-stud", "left-hoop", "right-hoop"]);
export const PiercingMetal = z.enum(["silver", "gold", "rose", "black"]);
export const Earrings = z.enum(["none", "drop", "star", "heart", "pearl", "charm"]);

/** Plain backdrops, drawn as a coloured circle. */
export const ColourBackground = z.enum([
  "sky",
  "mint",
  "peach",
  "lavender",
  "lemon",
  "rose",
  "slate",
  "none",
]);
/** Skylines, drawn as a little scene behind the hamster. */
export const CityBackground = z.enum([
  "london",
  "new_york",
  "san_francisco",
  "berlin",
  "paris",
  "tokyo",
  "sydney",
  "dubai",
  "newcastle",
  "brighton",
]);
export type ColourBackground = z.infer<typeof ColourBackground>;
export type CityBackground = z.infer<typeof CityBackground>;

export function isCityBackground(value: string): value is CityBackground {
  return CityBackground.options.some((city) => city === value);
}

/**
 * What a nibblet's hamster looks like. Each field is a choice among a small
 * set, the way a Mii is, so any combination draws well and a random one is
 * always valid.
 */
export const HamsterLook = z.object({
  fur: z.enum(["golden", "cream", "cinnamon", "grey", "chocolate", "black", "white", "lilac"]),
  pattern: z.enum(["solid", "banded", "patches", "roan", "masked"]),
  /** The belly, cheeks and muzzle. */
  belly: z.enum(["white", "cream", "same"]),
  ears: z.enum(["round", "tall", "floppy", "tiny"]),
  eyes: z.enum(["dot", "sparkle", "sleepy", "wide", "wink"]),
  eyeColour: z.enum(["black", "ruby", "brown", "blue"]),
  mouth: z.enum(["smile", "open", "cat", "flat", "tongue"]),
  cheeks: z.enum(["none", "blush", "stuffed"]),
  whiskers: z.boolean(),
  accessory: z.enum([
    "none",
    "glasses",
    "party_hat",
    "bow",
    "headphones",
    "beanie",
    "crown",
    "scarf",
  ]),
  accessoryColour: z.enum(["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]),
  background: z.enum([...ColourBackground.options, ...CityBackground.options]),
  // Defaults, so looks saved before piercings existed still parse.
  earPiercings: z.array(EarPiercing).default([]),
  nosePiercing: NosePiercing.default("none"),
  septum: z.boolean().default(false),
  piercingMetal: PiercingMetal.default("silver"),
  /** Dangly earrings on both lobes, in the piercing metal; gems take the accessory colour. */
  earrings: Earrings.default("none"),
});
export type HamsterLook = z.infer<typeof HamsterLook>;

export const defaultHamsterLook: HamsterLook = {
  fur: "golden",
  pattern: "banded",
  belly: "white",
  ears: "round",
  eyes: "dot",
  eyeColour: "black",
  mouth: "smile",
  cheeks: "blush",
  whiskers: true,
  accessory: "none",
  accessoryColour: "blue",
  background: "sky",
  earPiercings: [],
  nosePiercing: "none",
  septum: false,
  piercingMetal: "silver",
  earrings: "none",
};

/** A random but always valid look, for new nibblets and the editor's dice button. */
export function randomHamsterLook(random: () => number = Math.random): HamsterLook {
  const pick = <T>(options: readonly T[]): T => {
    const choice = options[Math.floor(random() * options.length)];
    if (choice === undefined) throw new Error("pick from an empty list");
    return choice;
  };
  const s = HamsterLook.shape;
  return {
    fur: pick(s.fur.options),
    pattern: pick(s.pattern.options),
    belly: pick(s.belly.options),
    ears: pick(s.ears.options),
    eyes: pick(s.eyes.options),
    eyeColour: pick(s.eyeColour.options),
    mouth: pick(s.mouth.options),
    cheeks: pick(s.cheeks.options),
    whiskers: random() > 0.25,
    accessory: random() > 0.5 ? pick(s.accessory.options) : "none",
    accessoryColour: pick(s.accessoryColour.options),
    background: pick(s.background.options),
    // Most hamsters are unpierced; a few get one or two.
    earPiercings: EarPiercing.options.filter(() => random() > 0.88),
    nosePiercing: random() > 0.85 ? pick(NosePiercing.options.slice(1)) : "none",
    septum: random() > 0.88,
    piercingMetal: pick(PiercingMetal.options),
    earrings: random() > 0.9 ? pick(Earrings.options.slice(1)) : "none",
  };
}

/** `waiting`: its usage limit or budget is hit; it carries on when that resets. */
export const NibbletStatus = z.enum(["stopped", "starting", "idle", "working", "waiting", "error"]);
export type NibbletStatus = z.infer<typeof NibbletStatus>;

/**
 * How much of the machine a nibblet may use. Null means the default: no CPU
 * cap, and DEFAULT_MEMORY_MB of memory.
 */
export const Resources = z.object({
  cpus: z.number().min(0.25).max(256).nullable(),
  memoryMb: z
    .int()
    .min(512)
    .max(1024 * 1024)
    .nullable(),
});
export type Resources = z.infer<typeof Resources>;
export const DEFAULT_MEMORY_MB = 4096;

/** A nibblet's monthly budget for API-key usage, in US dollars. */
export const MonthlyBudget = z.number().positive().max(1_000_000);
export const defaultResources: Resources = { cpus: null, memoryMb: null };

export const Nibblet = z.object({
  id: z.string(),
  name: z.string(),
  look: HamsterLook,
  harness: HarnessId,
  model: z.string(),
  effort: Effort,
  /** The nibblet's standing instructions: who it is and what it looks after. */
  instructions: z.string(),
  /** Set when this nibblet is a sub-agent another nibblet spawned. */
  parentId: z.string().nullable(),
  status: NibbletStatus,
  statusDetail: z.string().nullable(),
  heartbeats: z.array(Heartbeat),
  resources: Resources,
  /**
   * The most its API-key usage may cost in a calendar month (UTC), in US
   * dollars, or null for no limit. A sub-agent's usage counts against its
   * host's, and a subscription doesn't count at all.
   */
  monthlyBudgetUsd: z.number().nullable(),
  snapshotPolicy: SnapshotPolicy,
  /** Whether the container gets a browser it and the user can drive. */
  browser: z.boolean(),
  /** Host MCP servers this nibblet may use, by name. None unless ticked. */
  hostTools: z.array(z.string()),
  /** Host CLIs whose logins this nibblet borrows, by id (e.g. "gh"). None unless ticked. */
  cliCredentials: z.array(z.string()),
  /** MCP servers added to just this nibblet; header and env values come back masked. */
  mcpServers: z.array(McpServerDef),
  /** MCP tools that wait for the user to approve each call. */
  toolApprovals: ToolRules,
  /** Its own machine on the user's tailnet, or null for none. The auth key comes back masked. */
  tailscale: NibbletTailscale.nullable(),
  /** How that machine is doing, while its container is up. */
  tailnetNode: TailnetNode.nullable(),
  /** A short line the nibblet keeps current about what it's doing, like a chat status. */
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  statusUpdatedAt: Timestamp.nullable(),
  /** A gated tool call is waiting for the user. */
  awaitingApproval: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp.nullable(),
});
export type Nibblet = z.infer<typeof Nibblet>;

export const CreateNibblet = z.object({
  name: z.string().min(1).max(80),
  /** Random when left out. */
  look: HamsterLook.optional(),
  harness: HarnessId,
  model: z.string(),
  effort: Effort,
  instructions: z.string().default(""),
  browser: z.boolean().default(true),
  hostTools: z.array(z.string()).default([]),
  cliCredentials: z.array(z.string()).default([]),
  mcpServers: McpServerList.default([]),
  toolApprovals: ToolRules.default([]),
  /** First message, sent once the container is up. */
  message: z.string().optional(),
});
export type CreateNibblet = z.input<typeof CreateNibblet>;

export const UpdateNibblet = z.object({
  id: z.string(),
  name: z.string().min(1).max(80).optional(),
  look: HamsterLook.optional(),
  harness: HarnessId.optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  instructions: z.string().optional(),
  browser: z.boolean().optional(),
  hostTools: z.array(z.string()).optional(),
  cliCredentials: z.array(z.string()).optional(),
  /** Values equal to `MASKED` keep the stored secret. */
  mcpServers: McpServerList.optional(),
  toolApprovals: ToolRules.optional(),
  /** Null leaves the tailnet. An auth key equal to `MASKED` keeps the stored one. */
  tailscale: NibbletTailscale.nullable().optional(),
  // No heartbeats: the nibblet sets its own with the `heartbeat_*` tools.
  resources: Resources.optional(),
  /** Null for no limit. */
  monthlyBudgetUsd: MonthlyBudget.nullable().optional(),
  snapshotPolicy: SnapshotPolicy.optional(),
});

/** What started a turn. Anything but `user` is the nibblet acting on its own. */
export const TurnSource = z.enum(["user", "heartbeat", "schedule", "subagent", "system"]);
export type TurnSource = z.infer<typeof TurnSource>;

export const Usage = z.object({
  inputTokens: z.int(),
  outputTokens: z.int(),
  cachedInputTokens: z.int(),
});
export type Usage = z.infer<typeof Usage>;

const ItemBase = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  createdAt: Timestamp,
});

/** A file kept on the server: something the user attached, or something a nibblet shared. */
export const FileRef = z.object({
  fileId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.int(),
});
export type FileRef = z.infer<typeof FileRef>;

/**
 * One entry in a nibblet's thread. Items are upserted whole by `id`, never
 * patched, so a client that misses an update only has to take the next one.
 */
export const ThreadItem = z.discriminatedUnion("type", [
  ItemBase.extend({
    type: z.literal("user_message"),
    text: z.string(),
    source: TurnSource,
    attachments: z.array(FileRef).optional(),
  }),
  /** A file the nibblet shared with the user, uploading or ready to download. */
  ItemBase.extend({
    type: z.literal("file"),
    ...FileRef.shape,
    caption: z.string().nullable(),
    status: z.enum(["uploading", "ready", "failed"]),
    /** Bytes received so far, while uploading. */
    received: z.int(),
    error: z.string().nullable(),
  }),
  ItemBase.extend({
    type: z.literal("assistant_message"),
    text: z.string(),
    streaming: z.boolean(),
  }),
  ItemBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    streaming: z.boolean(),
  }),
  ItemBase.extend({
    type: z.literal("tool_call"),
    name: z.string(),
    /** The MCP server the tool came from, when it came from one. */
    server: z.string().nullable(),
    input: JsonValue,
    output: z.string().nullable(),
    status: z.enum(["running", "done", "error"]),
  }),
  ItemBase.extend({
    type: z.literal("subagent"),
    childId: z.string(),
    task: z.string(),
    status: z.enum(["running", "done", "error"]),
    result: z.string().nullable(),
  }),
  ItemBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    text: z.string(),
  }),
  ItemBase.extend({
    /** A gated MCP tool call, waiting for or decided by the user. */
    type: z.literal("approval"),
    server: z.string(),
    tool: z.string(),
    input: JsonValue,
    status: z.enum(["pending", "approved", "denied", "expired"]),
    reason: z.string().nullable(),
    decidedAt: Timestamp.nullable(),
  }),
  /**
   * The nibblet hit its subscription's usage limit, or its own monthly budget,
   * and is waiting for it to reset.
   */
  ItemBase.extend({
    type: z.literal("limit_wait"),
    /** Waits from before budgets were all for usage limits. */
    reason: z.enum(["usage", "budget"]).default("usage"),
    provider: z.enum(["anthropic", "openai"]).nullable(),
    /** When it carries on. */
    until: Timestamp,
    status: z.enum(["waiting", "resumed", "cancelled"]),
  }),
  ItemBase.extend({
    type: z.literal("turn"),
    source: TurnSource,
    status: z.enum(["running", "completed", "interrupted", "failed"]),
    /** A heartbeat or schedule turn that found nothing worth saying. */
    quiet: z.boolean(),
    usage: Usage.nullable(),
    endedAt: Timestamp.nullable(),
  }),
]);
export type ThreadItem = z.infer<typeof ThreadItem>;
export type ThreadItemType = ThreadItem["type"];
export type ThreadItemOf<T extends ThreadItemType> = Extract<ThreadItem, { type: T }>;

export const StoredItem = z.object({
  nibbletId: z.string(),
  seq: z.int(),
  item: ThreadItem,
});
export type StoredItem = z.infer<typeof StoredItem>;

export const Schedule = z.object({
  id: z.string(),
  nibbletId: z.string(),
  name: z.string(),
  /** A cron expression, or null for a one-shot at `runAt`. */
  cron: z.string().nullable(),
  runAt: Timestamp.nullable(),
  timezone: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  nextRunAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

/**
 * A long-running process the nibblet started with `task_start` (a dev
 * server, a game server, a watcher): it outlives the turn that started it,
 * but not the container.
 */
export const BackgroundTask = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "exited"]),
  /** Null while it runs, or when a signal ended it. */
  exitCode: z.int().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

/**
 * A desktop app installed in a nibblet's container, from its XDG desktop
 * entry, for the launcher the user and the agent share. `command` and
 * `args` are what to start: the entry's `Exec` with its field codes gone.
 */
export const DesktopApp = z.object({
  /** The desktop entry's id, like `org.xfce.mousepad`. */
  id: z.string(),
  name: z.string(),
  comment: z.string().nullable(),
  /** A `data:` URL of its icon, when one was found and small enough to send. */
  icon: z.string().nullable(),
  command: z.string(),
  args: z.array(z.string()),
  categories: z.array(z.string()),
});
export type DesktopApp = z.infer<typeof DesktopApp>;

export const CreateSchedule = z
  .object({
    nibbletId: z.string(),
    name: z.string().min(1),
    cron: z.string().nullable().default(null),
    runAt: Timestamp.nullable().default(null),
    timezone: z.string().default("UTC"),
    prompt: z.string().min(1),
  })
  .refine((s) => (s.cron === null) !== (s.runAt === null), {
    message: "Give exactly one of cron or runAt",
  });

export const Memory = z.object({
  id: z.string(),
  /** Null for memories every nibblet on the server shares. */
  nibbletId: z.string().nullable(),
  /** For a shared memory, the nibblet that shared it; null when the person did. */
  sharedBy: z.string().nullable().default(null),
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: Timestamp,
  /** Similarity to the query, on searches. */
  score: z.number().nullable(),
});
export type Memory = z.infer<typeof Memory>;

export const CredentialStatus = z.object({
  /**
   * `deepseek` is always an API key; `anthropic` and `openai` are a
   * subscription login, or an API key when `source` is `env`.
   */
  provider: z.enum(["anthropic", "openai", "deepseek"]),
  /** Where the proxy reads the credential from: `env` is an API key in its settings. */
  source: z.enum(["keychain", "file", "env", "none"]),
  ok: z.boolean(),
  detail: z.string(),
  plan: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
  /** Set while the subscription's usage limit is hit: when it resets. */
  limitedUntil: Timestamp.nullable().default(null),
});
export type CredentialStatus = z.infer<typeof CredentialStatus>;

export const TunnelConfig = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  /** A trycloudflare.com address that changes each time. Fine for trying it out. */
  z.object({ mode: z.literal("quick") }),
  /** A named tunnel from the Cloudflare dashboard, run with its token. */
  z.object({ mode: z.literal("token"), token: z.string().min(1), hostname: z.string().min(1) }),
]);
export type TunnelConfig = z.infer<typeof TunnelConfig>;

export const TunnelStatus = z.object({
  mode: z.enum(["off", "quick", "token"]),
  state: z.enum(["off", "starting", "up", "error"]),
  url: z.string().nullable(),
  detail: z.string().nullable(),
});
export type TunnelStatus = z.infer<typeof TunnelStatus>;

export const ServerInfo = z.object({
  serverId: z.string(),
  name: z.string(),
  version: z.string(),
  credentials: z.array(CredentialStatus),
  /** What the machine running the nibblets has, for sizing their limits. */
  host: z.object({ cpus: z.int(), memoryMb: z.int() }).nullable(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;
