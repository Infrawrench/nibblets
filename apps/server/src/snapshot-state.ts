import { items, memories, nibblets, schedules, type Db } from "@nibblet/db";
import {
  Effort,
  HarnessId,
  Heartbeat,
  isReservedMcpName,
  McpServerDef,
  Resources,
  ThreadItem,
  ToolRules,
} from "@nibblet/protocol";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * The database half of a snapshot: everything about a nibblet that isn't on
 * its disk. Its identity (name, look) and its snapshot policy stay as they
 * are when restoring; everything about how it behaves and what it knows goes
 * back to how it was.
 */
const AgentState = z.object({
  harness: HarnessId,
  model: z.string(),
  effort: Effort,
  instructions: z.string(),
  heartbeats: z.array(Heartbeat),
  resources: Resources,
  browser: z.boolean(),
  hostTools: z.array(z.string()),
  cliCredentials: z.array(z.string()),
  // Taken before a built-in claimed a server's name: restored without it.
  mcpServers: z
    .array(McpServerDef)
    .transform((list) => list.filter((server) => !isReservedMcpName(server.name))),
  toolApprovals: ToolRules,
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  statusUpdatedAt: z.string().nullable(),
});

export const SnapshotState = z.object({
  version: z.literal(1),
  takenAt: z.string(),
  nibblet: AgentState,
  items: z.array(
    z.object({ itemId: z.string(), seq: z.number(), item: ThreadItem, createdAt: z.string() }),
  ),
  memories: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["note", "transcript"]),
      content: z.string(),
      tags: z.array(z.string()),
      embedding: z.array(z.number()),
      createdAt: z.string(),
    }),
  ),
  schedules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      cron: z.string().nullable(),
      runAt: z.string().nullable(),
      timezone: z.string(),
      prompt: z.string(),
      enabled: z.boolean(),
      lastRunAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type SnapshotState = z.infer<typeof SnapshotState>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function exportState(db: Db, nibbletId: string): Promise<SnapshotState> {
  const [row] = await db.select().from(nibblets).where(eq(nibblets.id, nibbletId));
  if (!row) throw new Error(`No nibblet ${nibbletId}`);
  const itemRows = await db
    .select()
    .from(items)
    .where(eq(items.nibbletId, nibbletId))
    .orderBy(asc(items.seq));
  const memoryRows = await db.select().from(memories).where(eq(memories.nibbletId, nibbletId));
  const scheduleRows = await db.select().from(schedules).where(eq(schedules.nibbletId, nibbletId));
  return {
    version: 1,
    takenAt: new Date().toISOString(),
    nibblet: {
      harness: row.harness,
      model: row.model,
      effort: row.effort,
      instructions: row.instructions,
      heartbeats: row.heartbeats,
      resources: row.resources,
      browser: row.browser,
      hostTools: row.hostTools,
      cliCredentials: row.cliCredentials,
      mcpServers: row.mcpServers,
      toolApprovals: row.toolApprovals,
      statusText: row.statusText,
      statusEmoji: row.statusEmoji,
      statusUpdatedAt: iso(row.statusUpdatedAt),
    },
    items: itemRows.map((r) => ({
      itemId: r.itemId,
      seq: r.seq,
      item: r.item,
      createdAt: r.createdAt.toISOString(),
    })),
    memories: memoryRows.map((m) => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      tags: m.tags,
      embedding: m.embedding,
      createdAt: m.createdAt.toISOString(),
    })),
    schedules: scheduleRows.map((s) => ({
      id: s.id,
      name: s.name,
      cron: s.cron,
      runAt: iso(s.runAt),
      timezone: s.timezone,
      prompt: s.prompt,
      enabled: s.enabled,
      lastRunAt: iso(s.lastRunAt),
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

/**
 * Anything that was in flight when the snapshot was taken can't still be in
 * flight after a restore: no runner is waiting on it any more.
 */
export function settle(item: ThreadItem): ThreadItem {
  switch (item.type) {
    case "turn":
      return item.status === "running" ? { ...item, status: "interrupted" } : item;
    case "assistant_message":
    case "reasoning":
      return item.streaming ? { ...item, streaming: false } : item;
    case "tool_call":
      return item.status === "running"
        ? { ...item, status: "error", output: item.output ?? "Interrupted by a restore" }
        : item;
    case "approval":
      return item.status === "pending" ? { ...item, status: "expired" } : item;
    case "file":
      return item.status === "uploading"
        ? { ...item, status: "failed", error: "Interrupted by a restore" }
        : item;
    default:
      return item;
  }
}

const BATCH = 500;

/**
 * Replaces the nibblet's thread, own memories, schedules and agent state with
 * the snapshot's, in one transaction. Shared memories are never touched.
 * Thread items get fresh seqs, in their original order, so clients syncing
 * "since seq N" see them.
 */
export async function importState(db: Db, nibbletId: string, state: SnapshotState): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(items).where(eq(items.nibbletId, nibbletId));
    const ordered = [...state.items].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < ordered.length; i += BATCH) {
      // One row per statement keeps the new seqs strictly in the old order.
      for (const r of ordered.slice(i, i + BATCH)) {
        await tx.insert(items).values({
          nibbletId,
          itemId: r.itemId,
          seq: sql`nextval('item_seq')`,
          item: settle(r.item),
          createdAt: new Date(r.createdAt),
        });
      }
    }

    await tx.delete(memories).where(eq(memories.nibbletId, nibbletId));
    for (let i = 0; i < state.memories.length; i += BATCH) {
      const batch = state.memories.slice(i, i + BATCH);
      if (batch.length === 0) continue;
      await tx.insert(memories).values(
        batch.map((m) => ({
          id: m.id,
          nibbletId,
          kind: m.kind,
          content: m.content,
          tags: m.tags,
          embedding: m.embedding,
          createdAt: new Date(m.createdAt),
        })),
      );
    }

    await tx.delete(schedules).where(eq(schedules.nibbletId, nibbletId));
    if (state.schedules.length > 0) {
      await tx.insert(schedules).values(
        state.schedules.map((s) => ({
          id: s.id,
          nibbletId,
          name: s.name,
          cron: s.cron,
          runAt: s.runAt ? new Date(s.runAt) : null,
          timezone: s.timezone,
          prompt: s.prompt,
          enabled: s.enabled,
          lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
          createdAt: new Date(s.createdAt),
        })),
      );
    }

    const n = state.nibblet;
    await tx
      .update(nibblets)
      .set({
        harness: n.harness,
        model: n.model,
        effort: n.effort,
        instructions: n.instructions,
        heartbeats: n.heartbeats,
        resources: n.resources,
        browser: n.browser,
        hostTools: n.hostTools,
        cliCredentials: n.cliCredentials,
        mcpServers: n.mcpServers,
        toolApprovals: n.toolApprovals,
        statusText: n.statusText,
        statusEmoji: n.statusEmoji,
        statusUpdatedAt: n.statusUpdatedAt ? new Date(n.statusUpdatedAt) : null,
        harnessSessionId: null,
        awaitingApproval: false,
        updatedAt: new Date(),
      })
      .where(eq(nibblets.id, nibbletId));
  });
}

/** The newest thread item's seq, 0 for an empty thread. */
export async function maxSeq(db: Db, nibbletId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${items.seq})` })
    .from(items)
    .where(eq(items.nibbletId, nibbletId));
  return row?.max ? Number(row.max) : 0;
}

/** Messages in the thread, the user's and the nibblet's. */
export function messageCount(state: SnapshotState): number {
  return state.items.filter(
    (r) => r.item.type === "user_message" || r.item.type === "assistant_message",
  ).length;
}
