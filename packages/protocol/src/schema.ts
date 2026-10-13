import { z } from "zod";
import { McpServerDef, McpServerList } from "./mcp.ts";
import { Effort, HarnessId } from "./models.ts";

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
  background: z.enum(["sky", "mint", "peach", "lavender", "lemon", "rose", "slate", "none"]),
  // Defaults, so looks saved before piercings existed still parse.
  earPiercings: z.array(EarPiercing).default([]),
  nosePiercing: NosePiercing.default("none"),
  septum: z.boolean().default(false),
  piercingMetal: PiercingMetal.default("silver"),
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
  };
}

export const NibbletStatus = z.enum(["stopped", "starting", "idle", "working", "error"]);
export type NibbletStatus = z.infer<typeof NibbletStatus>;

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
  /** Whether the container gets a browser it and the user can drive. */
  browser: z.boolean(),
  /** Host MCP servers this nibblet may use, by name. None unless ticked. */
  hostTools: z.array(z.string()),
  /** Host CLIs whose logins this nibblet borrows, by id (e.g. "gh"). None unless ticked. */
  cliCredentials: z.array(z.string()),
  /** MCP servers added to just this nibblet; header and env values come back masked. */
  mcpServers: z.array(McpServerDef),
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
  // No heartbeats: the nibblet sets its own with the `heartbeat_*` tools.
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

/**
 * One entry in a nibblet's thread. Items are upserted whole by `id`, never
 * patched, so a client that misses an update only has to take the next one.
 */
export const ThreadItem = z.discriminatedUnion("type", [
  ItemBase.extend({
    type: z.literal("user_message"),
    text: z.string(),
    source: TurnSource,
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
  content: z.string(),
  tags: z.array(z.string()),
  createdAt: Timestamp,
  /** Similarity to the query, on searches. */
  score: z.number().nullable(),
});
export type Memory = z.infer<typeof Memory>;

export const CredentialStatus = z.object({
  provider: z.enum(["anthropic", "openai"]),
  /** Where the proxy reads the credential from. */
  source: z.enum(["keychain", "file", "none"]),
  ok: z.boolean(),
  detail: z.string(),
  plan: z.string().nullable(),
  expiresAt: Timestamp.nullable(),
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
});
export type ServerInfo = z.infer<typeof ServerInfo>;
