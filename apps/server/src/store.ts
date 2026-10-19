import {
  authTokens,
  cards,
  items,
  memories,
  nibblets,
  pairingCodes,
  schedules,
  settings,
  spend,
  type Db,
} from "@nibblet/db";
import {
  HamsterLook,
  MASKED,
  maskMcpServers,
  McpServerList,
  ToolRules,
  randomHamsterLook,
  RpcError,
  type Card,
  type CreateNibblet,
  type Heartbeat,
  type Memory,
  type Nibblet,
  type NibbletStatus,
  type Schedule,
  type StoredItem,
  type ThreadItem,
} from "@nibblet/protocol";
import { and, asc, cosineDistance, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Bus } from "./bus.ts";
import type { Embedder } from "./embeddings.ts";

type NibbletRow = typeof nibblets.$inferSelect;
type ScheduleRow = typeof schedules.$inferSelect;
export type CardRow = typeof cards.$inferSelect;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The token OpenComputerUse in a nibblet's container accepts, derived so it survives restarts. */
export function viewToken(ownerToken: string, nibbletId: string, tokenHash: string): string {
  return createHmac("sha256", ownerToken)
    .update(`view:${nibbletId}:${tokenHash}`)
    .digest("base64url");
}

/**
 * The token a nibblet's desktop (the OpenComputerUse for its apps, run as
 * the agent's user) accepts; derived like the view token, but apart from it,
 * since the agent may know this one and must never know that.
 */
export function desktopToken(ownerToken: string, nibbletId: string, tokenHash: string): string {
  return createHmac("sha256", ownerToken)
    .update(`desktop:${nibbletId}:${tokenHash}`)
    .digest("base64url");
}

/**
 * The token a nibblet's guard (the separate user in its container that holds
 * its secrets) uses for /guard/:id; derived like the view token.
 */
export function guardToken(ownerToken: string, nibbletId: string, tokenHash: string): string {
  return createHmac("sha256", ownerToken)
    .update(`guard:${nibbletId}:${tokenHash}`)
    .digest("base64url");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toNibblet(row: NibbletRow): Nibblet {
  return {
    id: row.id,
    name: row.name,
    // Fills in fields added since the look was saved (piercings, say).
    look: HamsterLook.parse(row.look),
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    instructions: row.instructions,
    promptName: row.promptName,
    plain: row.plain,
    parentId: row.parentId,
    status: row.status,
    statusDetail: row.statusDetail,
    heartbeats: row.heartbeats,
    resources: row.resources,
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    snapshotPolicy: row.snapshotPolicy,
    browser: row.browser,
    hostTools: row.hostTools,
    cliCredentials: row.cliCredentials,
    mcpServers: maskMcpServers(row.mcpServers),
    toolApprovals: row.toolApprovals,
    // Empty stays empty: it has no key of its own, and one's made when it joins.
    tailscale: row.tailscale
      ? { ...row.tailscale, authKey: row.tailscale.authKey ? MASKED : "" }
      : null,
    tailnetNode: row.tailnetNode,
    spendingLimits: row.spendingLimits,
    statusText: row.statusText,
    statusEmoji: row.statusEmoji,
    statusUpdatedAt: iso(row.statusUpdatedAt),
    awaitingApproval: row.awaitingApproval,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: iso(row.lastActivityAt),
  };
}

export function toCard(row: CardRow): Card {
  return {
    id: row.id,
    nibbletId: row.nibbletId,
    provider: row.provider,
    asset: { code: row.asset, decimals: row.decimals },
    kind: row.kind,
    limit: row.limitMinor,
    spent: row.spentMinor,
    purpose: row.purpose,
    display: row.display,
    state: row.state,
    closedBy: row.closedBy,
    createdAt: row.createdAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

function toSchedule(row: ScheduleRow, nextRunAt: Date | null): Schedule {
  return {
    id: row.id,
    nibbletId: row.nibbletId,
    name: row.name,
    cron: row.cron,
    runAt: iso(row.runAt),
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    nextRunAt: iso(nextRunAt),
    lastRunAt: iso(row.lastRunAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * All database access. Methods that change something the UI shows publish
 * it on the bus, so callers never have to remember to.
 */
export class Store {
  readonly db: Db;
  private readonly bus: Bus;
  private readonly embedder: Embedder;

  constructor(db: Db, bus: Bus, embedder: Embedder) {
    this.db = db;
    this.bus = bus;
    this.embedder = embedder;
  }

  // Settings

  async getSetting<T>(key: string, parse: (v: unknown) => T, fallback: T): Promise<T> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key));
    if (!row) return fallback;
    try {
      return parse(row.value);
    } catch {
      return fallback;
    }
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }
  async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  // Nibblets

  async listNibblets(): Promise<Nibblet[]> {
    const rows = await this.db.select().from(nibblets).orderBy(asc(nibblets.createdAt));
    return rows.map(toNibblet);
  }

  async nibbletRow(id: string): Promise<NibbletRow> {
    const [row] = await this.db.select().from(nibblets).where(eq(nibblets.id, id));
    if (!row) throw new RpcError("not_found", `No nibblet ${id}`);
    return row;
  }

  async getNibblet(id: string): Promise<Nibblet> {
    return toNibblet(await this.nibbletRow(id));
  }

  async nibbletByToken(token: string): Promise<NibbletRow | null> {
    const [row] = await this.db
      .select()
      .from(nibblets)
      .where(eq(nibblets.tokenHash, hashToken(token)));
    return row ?? null;
  }

  /** Creates the row and returns the runner token, which is only ever known here. */
  async createNibblet(
    input: Omit<CreateNibblet, "message">,
    parentId: string | null,
  ): Promise<{ nibblet: Nibblet; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const [row] = await this.db
      .insert(nibblets)
      .values({
        id: newId("nib"),
        name: input.name,
        look: HamsterLook.parse(input.look ?? randomHamsterLook()),
        harness: input.harness,
        model: input.model,
        effort: input.effort,
        instructions: input.instructions ?? "",
        promptName: input.promptName ?? null,
        plain: input.plain ?? false,
        parentId,
        browser: input.browser ?? true,
        hostTools: input.hostTools ?? [],
        cliCredentials: input.cliCredentials ?? [],
        mcpServers: McpServerList.parse(input.mcpServers ?? []),
        toolApprovals: ToolRules.parse(input.toolApprovals ?? []),
        tokenHash: hashToken(token),
      })
      .returning();
    if (!row) throw new Error("insert returned nothing");
    const nibblet = toNibblet(row);
    this.bus.publish({ type: "nibblet", nibblet });
    return { nibblet, token };
  }

  async updateNibblet(
    id: string,
    patch: Partial<Omit<typeof nibblets.$inferInsert, "id" | "createdAt">>,
  ): Promise<Nibblet> {
    const [row] = await this.db
      .update(nibblets)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(nibblets.id, id))
      .returning();
    if (!row) throw new RpcError("not_found", `No nibblet ${id}`);
    const nibblet = toNibblet(row);
    this.bus.publish({ type: "nibblet", nibblet });
    return nibblet;
  }

  async setStatus(id: string, status: NibbletStatus, detail: string | null = null): Promise<void> {
    await this.updateNibblet(id, { status, statusDetail: detail });
  }

  /** A fresh runner token, for when a container is recreated. */
  async rotateToken(id: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db
      .update(nibblets)
      .set({ tokenHash: hashToken(token) })
      .where(eq(nibblets.id, id));
    return token;
  }

  /** Replaces a nibblet's heartbeats, keeping its other fields as they are. */
  async setHeartbeats(id: string, heartbeats: Heartbeat[]): Promise<Nibblet> {
    return this.updateNibblet(id, { heartbeats });
  }

  async deleteNibblet(id: string): Promise<void> {
    await this.db.delete(nibblets).where(eq(nibblets.id, id));
    this.bus.publish({ type: "nibblet_deleted", id });
  }

  async children(parentId: string): Promise<Nibblet[]> {
    const rows = await this.db.select().from(nibblets).where(eq(nibblets.parentId, parentId));
    return rows.map(toNibblet);
  }

  // Spending on API keys

  /** What a nibblet's API-key usage has cost in a month (`2026-10`), in US dollars. */
  async spentUsd(nibbletId: string, month: string): Promise<number> {
    const [row] = await this.db
      .select({ costUsd: spend.costUsd })
      .from(spend)
      .where(and(eq(spend.nibbletId, nibbletId), eq(spend.month, month)));
    return row?.costUsd ?? 0;
  }

  /** Adds one request's cost to a nibblet's month, returning the month's new total. */
  async addSpend(nibbletId: string, month: string, costUsd: number): Promise<number> {
    const [row] = await this.db
      .insert(spend)
      .values({ nibbletId, month, costUsd, requests: 1 })
      .onConflictDoUpdate({
        target: [spend.nibbletId, spend.month],
        set: {
          costUsd: sql`${spend.costUsd} + ${costUsd}`,
          requests: sql`${spend.requests} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ costUsd: spend.costUsd });
    return row?.costUsd ?? costUsd;
  }

  // Thread items

  /** Upserts an item with a fresh seq, so clients syncing "since N" see the change. */
  async putItem(nibbletId: string, item: ThreadItem): Promise<StoredItem> {
    const [row] = await this.db
      .insert(items)
      .values({ nibbletId, itemId: item.id, seq: sql`nextval('item_seq')`, item })
      .onConflictDoUpdate({
        target: [items.nibbletId, items.itemId],
        set: { item, seq: sql`nextval('item_seq')` },
      })
      .returning({ seq: items.seq });
    if (!row) throw new Error("upsert returned nothing");
    const stored: StoredItem = { nibbletId, seq: row.seq, item };
    this.bus.publish({ type: "item", item: stored });
    return stored;
  }

  async itemsSince(nibbletId: string, sinceSeq: number, limit = 2000): Promise<StoredItem[]> {
    const rows = await this.db
      .select()
      .from(items)
      .where(and(eq(items.nibbletId, nibbletId), gt(items.seq, sinceSeq)))
      .orderBy(asc(items.seq))
      .limit(limit);
    return rows.map((r) => ({ nibbletId: r.nibbletId, seq: r.seq, item: r.item }));
  }

  async getItem(nibbletId: string, itemId: string): Promise<ThreadItem | null> {
    const [row] = await this.db
      .select()
      .from(items)
      .where(and(eq(items.nibbletId, nibbletId), eq(items.itemId, itemId)));
    return row?.item ?? null;
  }

  /** Approval items still marked pending, across every nibblet. */
  async pendingApprovalItems(): Promise<
    { nibbletId: string; item: Extract<ThreadItem, { type: "approval" }> }[]
  > {
    const rows = await this.db
      .select({ nibbletId: items.nibbletId, item: items.item })
      .from(items)
      .where(
        and(sql`${items.item}->>'type' = 'approval'`, sql`${items.item}->>'status' = 'pending'`),
      );
    return rows.flatMap((r) =>
      r.item.type === "approval" ? [{ nibbletId: r.nibbletId, item: r.item }] : [],
    );
  }

  /** Turn items still marked running, across every nibblet. */
  async runningTurnItems(): Promise<
    { nibbletId: string; item: Extract<ThreadItem, { type: "turn" }> }[]
  > {
    const rows = await this.db
      .select({ nibbletId: items.nibbletId, item: items.item })
      .from(items)
      .where(and(sql`${items.item}->>'type' = 'turn'`, sql`${items.item}->>'status' = 'running'`));
    return rows.flatMap((r) =>
      r.item.type === "turn" ? [{ nibbletId: r.nibbletId, item: r.item }] : [],
    );
  }

  async clearAwaitingApproval(): Promise<void> {
    await this.db
      .update(nibblets)
      .set({ awaitingApproval: false })
      .where(eq(nibblets.awaitingApproval, true));
  }

  /** The parent's still-running record of a sub-agent, if there is one. */
  async runningSubagentItem(
    parentId: string,
    childId: string,
  ): Promise<Extract<ThreadItem, { type: "subagent" }> | null> {
    const rows = await this.db
      .select({ item: items.item })
      .from(items)
      .where(
        and(
          eq(items.nibbletId, parentId),
          sql`${items.item}->>'type' = 'subagent'`,
          sql`${items.item}->>'childId' = ${childId}`,
          sql`${items.item}->>'status' = 'running'`,
        ),
      );
    const item = rows[0]?.item;
    return item?.type === "subagent" ? item : null;
  }

  /** The newest items in creation order, for recaps. */
  async recentItems(nibbletId: string, limit: number): Promise<ThreadItem[]> {
    const rows = await this.db
      .select({ item: items.item })
      .from(items)
      .where(eq(items.nibbletId, nibbletId))
      .orderBy(desc(items.createdAt))
      .limit(limit);
    return rows.map((r) => r.item).reverse();
  }

  // Schedules

  async listSchedules(nibbletId?: string): Promise<ScheduleRow[]> {
    const q = this.db.select().from(schedules);
    return nibbletId ? q.where(eq(schedules.nibbletId, nibbletId)) : q;
  }

  async createCard(input: Omit<typeof cards.$inferInsert, "createdAt">): Promise<CardRow> {
    const [row] = await this.db.insert(cards).values(input).returning();
    if (!row) throw new Error("insert returned nothing");
    return row;
  }

  async cardRow(id: string): Promise<CardRow> {
    const [row] = await this.db.select().from(cards).where(eq(cards.id, id));
    if (!row) throw new RpcError("not_found", `No card ${id}`);
    return row;
  }

  /** A nibblet's cards, newest first. */
  async cardsOf(nibbletId: string): Promise<CardRow[]> {
    return this.db
      .select()
      .from(cards)
      .where(eq(cards.nibbletId, nibbletId))
      .orderBy(desc(cards.createdAt));
  }

  /** Every card that's still open, on any nibblet. */
  async openCards(): Promise<CardRow[]> {
    return this.db.select().from(cards).where(eq(cards.state, "open"));
  }

  async updateCard(
    id: string,
    patch: Partial<Omit<typeof cards.$inferInsert, "id" | "createdAt">>,
  ): Promise<CardRow> {
    const [row] = await this.db.update(cards).set(patch).where(eq(cards.id, id)).returning();
    if (!row) throw new RpcError("not_found", `No card ${id}`);
    return row;
  }

  async scheduleRow(id: string): Promise<ScheduleRow> {
    const [row] = await this.db.select().from(schedules).where(eq(schedules.id, id));
    if (!row) throw new RpcError("not_found", `No schedule ${id}`);
    return row;
  }

  async createSchedule(
    input: Omit<typeof schedules.$inferInsert, "id" | "createdAt">,
  ): Promise<ScheduleRow> {
    const [row] = await this.db
      .insert(schedules)
      .values({ id: newId("sch"), ...input })
      .returning();
    if (!row) throw new Error("insert returned nothing");
    this.bus.publish({ type: "schedules_changed", nibbletId: row.nibbletId });
    return row;
  }

  async updateSchedule(
    id: string,
    patch: Partial<typeof schedules.$inferInsert>,
  ): Promise<ScheduleRow> {
    const [row] = await this.db
      .update(schedules)
      .set(patch)
      .where(eq(schedules.id, id))
      .returning();
    if (!row) throw new RpcError("not_found", `No schedule ${id}`);
    this.bus.publish({ type: "schedules_changed", nibbletId: row.nibbletId });
    return row;
  }

  async deleteSchedule(id: string): Promise<void> {
    const [row] = await this.db.delete(schedules).where(eq(schedules.id, id)).returning();
    if (row) this.bus.publish({ type: "schedules_changed", nibbletId: row.nibbletId });
  }

  toSchedule = toSchedule;

  // Memories

  async saveMemory(input: {
    nibbletId: string | null;
    /** For a shared memory, the nibblet sharing it. */
    sharedBy?: string | null;
    content: string;
    tags: string[];
    kind?: "note" | "transcript";
  }): Promise<Memory> {
    const [embedding] = await this.embedder.embed([input.content], "document");
    if (!embedding) throw new Error("embedder returned nothing");
    const [row] = await this.db
      .insert(memories)
      .values({
        id: newId("mem"),
        nibbletId: input.nibbletId,
        sharedBy: input.nibbletId === null ? (input.sharedBy ?? null) : null,
        kind: input.kind ?? "note",
        content: input.content,
        tags: input.tags,
        embedding,
      })
      .returning();
    if (!row) throw new Error("insert returned nothing");
    return {
      id: row.id,
      nibbletId: row.nibbletId,
      sharedBy: row.sharedBy,
      content: row.content,
      tags: row.tags,
      createdAt: row.createdAt.toISOString(),
      score: null,
    };
  }

  /**
   * Memories a nibblet can see: its own and the shared ones. With a query,
   * ranked by cosine similarity; without, newest first.
   */
  async searchMemories(opts: {
    nibbletId: string | null;
    query?: string;
    limit?: number;
    kinds?: ("note" | "transcript")[];
    /**
     * Leave out notes other nibblets shared, for what goes into a prompt
     * unasked: a nibblet that read something nasty can't steer the rest.
     */
    trustedOnly?: boolean;
  }): Promise<Memory[]> {
    const limit = opts.limit ?? 20;
    const kinds = opts.kinds ?? ["note"];
    const shared =
      opts.trustedOnly && opts.nibbletId !== null
        ? and(
            isNull(memories.nibbletId),
            or(isNull(memories.sharedBy), eq(memories.sharedBy, opts.nibbletId)),
          )
        : isNull(memories.nibbletId);
    const visible =
      opts.nibbletId === null ? shared : or(eq(memories.nibbletId, opts.nibbletId), shared);
    const where = and(visible, inArray(memories.kind, kinds));
    const columns = {
      id: memories.id,
      nibbletId: memories.nibbletId,
      sharedBy: memories.sharedBy,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
    };

    if (!opts.query) {
      const rows = await this.db
        .select(columns)
        .from(memories)
        .where(where)
        .orderBy(desc(memories.createdAt))
        .limit(limit);
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), score: null }));
    }

    const [vector] = await this.embedder.embed([opts.query], "query");
    if (!vector) return [];
    const distance = cosineDistance(memories.embedding, vector);
    const rows = await this.db
      .select({ ...columns, distance })
      .from(memories)
      .where(where)
      .orderBy(distance)
      .limit(limit);
    return rows.map(({ distance: d, ...r }) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      score: 1 - Number(d),
    }));
  }

  /**
   * Deletes a memory. A nibblet may delete only its own notes and the shared
   * ones it shared itself, not the person's or another nibblet's.
   */
  async deleteMemory(id: string, nibbletId?: string): Promise<boolean> {
    const where = nibbletId
      ? and(
          eq(memories.id, id),
          or(
            eq(memories.nibbletId, nibbletId),
            and(isNull(memories.nibbletId), eq(memories.sharedBy, nibbletId)),
          ),
        )
      : eq(memories.id, id);
    const rows = await this.db.delete(memories).where(where).returning({ id: memories.id });
    return rows.length > 0;
  }

  // Sign-ins

  async issueAuthToken(label: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db
      .insert(authTokens)
      .values({ id: newId("tok"), tokenHash: hashToken(token), label });
    return token;
  }

  async checkAuthToken(token: string): Promise<boolean> {
    const rows = await this.db
      .update(authTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(authTokens.tokenHash, hashToken(token)))
      .returning({ id: authTokens.id });
    return rows.length > 0;
  }

  async createPairingCode(ttlMs: number): Promise<{ code: string; expiresAt: Date }> {
    const code = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, new Date()));
    await this.db.insert(pairingCodes).values({ codeHash: hashToken(code), expiresAt });
    return { code, expiresAt };
  }

  /** Spends a pairing code; true if it was valid. */
  async redeemPairingCode(code: string): Promise<boolean> {
    const rows = await this.db
      .delete(pairingCodes)
      .where(
        and(eq(pairingCodes.codeHash, hashToken(code)), gt(pairingCodes.expiresAt, new Date())),
      )
      .returning({ codeHash: pairingCodes.codeHash });
    return rows.length > 0;
  }
}
