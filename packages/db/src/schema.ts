import type {
  CardClosedBy,
  CardKind,
  CardState,
  Effort,
  MachineChoice,
  HamsterLook,
  HarnessId,
  Heartbeat,
  Resources,
  SnapshotPolicy,
  SnapshotTrigger,
  McpServerDef,
  NibbletLocation,
  ToolRule,
  NibbletStatus,
  NibbletTailscale,
  SpendingLimit,
  TailnetNode,
  ThreadItem,
} from "@nibblet/protocol";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

/** Every embedding is this wide; the local model and any replacement must agree. */
export const EMBEDDING_DIMENSIONS = 384;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const nibblets = pgTable("nibblets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  look: jsonb("look").$type<HamsterLook>().notNull(),
  harness: text("harness").$type<HarnessId>().notNull(),
  model: text("model").notNull(),
  effort: text("effort").$type<Effort>().notNull(),
  instructions: text("instructions").notNull().default(""),
  parentId: text("parent_id"),
  status: text("status").$type<NibbletStatus>().notNull().default("stopped"),
  statusDetail: text("status_detail"),
  /** Stored in the column that held the single heartbeat before there were several. */
  heartbeats: jsonb("heartbeat").$type<Heartbeat[]>().notNull().default([]),
  resources: jsonb("resources")
    .$type<Resources>()
    .notNull()
    .default({ cpus: null, memoryMb: null }),
  /** US dollars a calendar month of API-key usage may cost; null for no limit. */
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
  snapshotPolicy: jsonb("snapshot_policy")
    .$type<SnapshotPolicy>()
    .notNull()
    .default({ everyMinutes: 24 * 60, keep: 7 }),
  /** Null for its own name, empty for none. */
  promptName: text("prompt_name"),
  plain: boolean("plain").notNull().default(false),
  /** Which machine plugin it runs on, and the guest; every nibblet before there was a choice was a container. */
  machine: jsonb("machine")
    .$type<MachineChoice>()
    .notNull()
    .default({ backend: "docker", guest: "linux" }),
  browser: boolean("browser").notNull().default(true),
  hostTools: text("host_tools").array().notNull().default([]),
  cliCredentials: text("cli_credentials").array().notNull().default([]),
  /** Unmasked: the API masks header and env values on the way out. */
  mcpServers: jsonb("mcp_servers").$type<McpServerDef[]>().notNull().default([]),
  toolApprovals: jsonb("tool_approvals").$type<ToolRule[]>().notNull().default([]),
  /** Unmasked, like `mcpServers`: the API masks the auth key on the way out. */
  tailscale: jsonb("tailscale").$type<NibbletTailscale>(),
  tailnetNode: jsonb("tailnet_node").$type<TailnetNode>(),
  spendingLimits: jsonb("spending_limits").$type<SpendingLimit[]>().notNull().default([]),
  /** Where its person last said they were, with the place it's in. */
  location: jsonb("location").$type<NibbletLocation>(),
  statusText: text("status_text"),
  statusEmoji: text("status_emoji"),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
  awaitingApproval: boolean("awaiting_approval").notNull().default(false),
  /** Hash of the token its runner and its tool calls authenticate with. */
  tokenHash: text("token_hash").notNull(),
  containerId: text("container_id"),
  harnessSessionId: text("harness_session_id"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
});

/** One global sequence, so "everything since seq N" works across nibblets. */
export const itemSeq = pgSequence("item_seq");

export const items = pgTable(
  "items",
  {
    nibbletId: text("nibblet_id")
      .notNull()
      .references(() => nibblets.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    item: jsonb("item").$type<ThreadItem>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.nibbletId, t.itemId] }),
    index("items_seq_idx").on(t.nibbletId, t.seq),
  ],
);

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  nibbletId: text("nibblet_id")
    .notNull()
    .references(() => nibblets.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cron: text("cron"),
  runAt: timestamp("run_at", { withTimezone: true }),
  timezone: text("timezone").notNull().default("UTC"),
  prompt: text("prompt").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    /** Null for memories shared by every nibblet on the server. */
    nibbletId: text("nibblet_id").references(() => nibblets.id, { onDelete: "cascade" }),
    /**
     * For a shared memory, the nibblet that shared it; null when the person
     * did (or for ones from before this was kept). A nibblet's shared notes
     * reach the others only when searched for, never into their prompts.
     */
    sharedBy: text("shared_by"),
    /** `note`s are saved on purpose; `transcript` chunks are indexed from threads. */
    kind: text("kind").$type<"note" | "transcript">().notNull().default("note"),
    content: text("content").notNull(),
    tags: text("tags").array().notNull().default([]),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("memories_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("memories_nibblet_idx").on(t.nibbletId, t.kind),
  ],
);

/** Long-lived sign-ins: the desktop app, a paired phone, a peer server. */
export const authTokens = pgTable("auth_tokens", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const pairingCodes = pgTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Files on the server's data volume, under `files/<nibbletId>/<id>`: what
 * the user attached to a message, and what a nibblet shared back.
 */
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    nibbletId: text("nibblet_id")
      .notNull()
      .references(() => nibblets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    direction: text("direction").$type<"user" | "nibblet">().notNull(),
    status: text("status").$type<"uploading" | "ready" | "failed">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("files_nibblet_idx").on(t.nibbletId)],
);

/**
 * Snapshots of a nibblet: its home folder and state, stored as files under
 * `snapshots/<nibbletId>/<id>.*` on the data volume.
 */
export const snapshots = pgTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    nibbletId: text("nibblet_id")
      .notNull()
      .references(() => nibblets.id, { onDelete: "cascade" }),
    label: text("label"),
    trigger: text("trigger").$type<SnapshotTrigger>().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    messageCount: integer("message_count").notNull(),
    /** The newest thread item's seq when it was taken, to tell whether anything has changed since. */
    maxSeq: bigint("max_seq", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("snapshots_nibblet_idx").on(t.nibbletId, t.createdAt)],
);

/**
 * What a nibblet's API-key usage has cost, a calendar month (UTC) at a time,
 * as the credential proxy reports it. A sub-agent's goes to its host's row.
 */
export const spend = pgTable(
  "spend",
  {
    nibbletId: text("nibblet_id")
      .notNull()
      .references(() => nibblets.id, { onDelete: "cascade" }),
    /** Like `2026-10`. */
    month: text("month").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nibbletId, t.month] })],
);

/**
 * Cards (and crypto wallets) a nibblet has been given. What they can be spent
 * with is never stored: the provider gives it again (or, for a wallet, its key
 * is derived again) whenever the nibblet's container needs the file.
 */
export const cards = pgTable(
  "cards",
  {
    id: text("id").primaryKey(),
    nibbletId: text("nibblet_id")
      .notNull()
      .references(() => nibblets.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The provider's own id for it (a card's id, a wallet's address); empty while pending. */
    ref: text("ref").notNull(),
    asset: text("asset").notNull(),
    decimals: integer("decimals").notNull(),
    kind: text("kind").$type<CardKind>().notNull(),
    /** In the asset's smallest unit. */
    limitMinor: numeric("limit_minor", { precision: 78, scale: 0 }).notNull(),
    spentMinor: numeric("spent_minor", { precision: 78, scale: 0 }).notNull().default("0"),
    purpose: text("purpose").notNull(),
    display: text("display").notNull(),
    state: text("state").$type<CardState>().notNull().default("pending"),
    closedBy: text("closed_by").$type<CardClosedBy>(),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [
    index("cards_nibblet_idx").on(t.nibbletId, t.createdAt),
    index("cards_state_idx").on(t.state),
  ],
);
