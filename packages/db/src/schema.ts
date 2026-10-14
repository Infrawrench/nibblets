import type {
  Effort,
  HamsterLook,
  HarnessId,
  Heartbeat,
  Resources,
  SnapshotPolicy,
  SnapshotTrigger,
  McpServerDef,
  ToolRule,
  NibbletStatus,
  ThreadItem,
} from "@nibblet/protocol";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
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
  snapshotPolicy: jsonb("snapshot_policy")
    .$type<SnapshotPolicy>()
    .notNull()
    .default({ everyMinutes: 24 * 60, keep: 7 }),
  browser: boolean("browser").notNull().default(true),
  hostTools: text("host_tools").array().notNull().default([]),
  cliCredentials: text("cli_credentials").array().notNull().default([]),
  /** Unmasked: the API masks header and env values on the way out. */
  mcpServers: jsonb("mcp_servers").$type<McpServerDef[]>().notNull().default([]),
  toolApprovals: jsonb("tool_approvals").$type<ToolRule[]>().notNull().default([]),
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
