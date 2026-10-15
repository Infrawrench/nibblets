import { nibblets, paymentAccounts, paymentCards, paymentCharges, type Db } from "@nibblet/db";
import { defaultPaymentPolicy, PaymentPolicy, RpcError } from "@nibblet/protocol";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";

export type AccountRow = typeof paymentAccounts.$inferSelect;
export type CardRow = typeof paymentCards.$inferSelect;
export type ChargeRow = typeof paymentCharges.$inferSelect;

/** The database calls payments make, so tests can stand in for Postgres. */
export interface PaymentsRepo {
  accounts(): Promise<AccountRow[]>;
  account(id: string): Promise<AccountRow | null>;
  insertAccount(row: Omit<AccountRow, "createdAt">): Promise<AccountRow>;
  updateAccount(
    id: string,
    patch: Partial<Omit<AccountRow, "id" | "createdAt">>,
  ): Promise<AccountRow>;
  deleteAccount(id: string): Promise<void>;

  policy(nibbletId: string): Promise<PaymentPolicy>;
  setPolicy(nibbletId: string, policy: PaymentPolicy): Promise<void>;
  /** Every nibblet with access to an account, for taking it away when the account goes. */
  policies(): Promise<{ nibbletId: string; policy: PaymentPolicy }[]>;

  cards(nibbletId: string): Promise<CardRow[]>;
  card(id: string): Promise<CardRow | null>;
  /** Live cards, plus closed ones that may still see late charges or refunds. */
  watchedCards(closedSince: Date): Promise<CardRow[]>;
  /** Provider refs of every live card from a provider, so none goes out twice. */
  activeRefs(provider: string): Promise<Set<string>>;
  insertCard(row: Omit<CardRow, "createdAt"> & { createdAt?: Date }): Promise<CardRow>;
  updateCard(id: string, patch: Partial<Omit<CardRow, "id">>): Promise<CardRow>;

  charges(cardIds: string[]): Promise<ChargeRow[]>;
  upsertCharges(rows: ChargeRow[]): Promise<void>;
}

export class DbPaymentsRepo implements PaymentsRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  accounts() {
    return this.db.select().from(paymentAccounts).orderBy(paymentAccounts.createdAt);
  }

  async account(id: string) {
    const [row] = await this.db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id));
    return row ?? null;
  }

  async insertAccount(row: Omit<AccountRow, "createdAt">) {
    const [out] = await this.db.insert(paymentAccounts).values(row).returning();
    if (!out) throw new Error("insert returned nothing");
    return out;
  }

  async updateAccount(id: string, patch: Partial<Omit<AccountRow, "id" | "createdAt">>) {
    const [out] = await this.db
      .update(paymentAccounts)
      .set(patch)
      .where(eq(paymentAccounts.id, id))
      .returning();
    if (!out) throw new RpcError("not_found", "No such payment account");
    return out;
  }

  async deleteAccount(id: string) {
    await this.db.delete(paymentAccounts).where(eq(paymentAccounts.id, id));
  }

  async policy(nibbletId: string) {
    const [row] = await this.db
      .select({ payments: nibblets.payments })
      .from(nibblets)
      .where(eq(nibblets.id, nibbletId));
    if (!row) throw new RpcError("not_found", `No nibblet ${nibbletId}`);
    const parsed = PaymentPolicy.safeParse(row.payments);
    return parsed.success ? parsed.data : defaultPaymentPolicy;
  }

  async setPolicy(nibbletId: string, policy: PaymentPolicy) {
    await this.db.update(nibblets).set({ payments: policy }).where(eq(nibblets.id, nibbletId));
  }

  async policies() {
    const rows = await this.db
      .select({ nibbletId: nibblets.id, payments: nibblets.payments })
      .from(nibblets);
    return rows.flatMap((r) => {
      const parsed = PaymentPolicy.safeParse(r.payments);
      return parsed.success ? [{ nibbletId: r.nibbletId, policy: parsed.data }] : [];
    });
  }

  cards(nibbletId: string) {
    return this.db
      .select()
      .from(paymentCards)
      .where(eq(paymentCards.nibbletId, nibbletId))
      .orderBy(paymentCards.createdAt);
  }

  async card(id: string) {
    const [row] = await this.db.select().from(paymentCards).where(eq(paymentCards.id, id));
    return row ?? null;
  }

  watchedCards(closedSince: Date) {
    return this.db
      .select()
      .from(paymentCards)
      .where(
        or(
          eq(paymentCards.status, "active"),
          isNull(paymentCards.closedAt),
          gt(paymentCards.closedAt, closedSince),
        ),
      );
  }

  async activeRefs(provider: string) {
    const rows = await this.db
      .select({ ref: paymentCards.providerRef })
      .from(paymentCards)
      .where(and(eq(paymentCards.provider, provider), eq(paymentCards.status, "active")));
    return new Set(rows.map((r) => r.ref));
  }

  async insertCard(row: Omit<CardRow, "createdAt"> & { createdAt?: Date }) {
    const [out] = await this.db.insert(paymentCards).values(row).returning();
    if (!out) throw new Error("insert returned nothing");
    return out;
  }

  async updateCard(id: string, patch: Partial<Omit<CardRow, "id">>) {
    const [out] = await this.db
      .update(paymentCards)
      .set(patch)
      .where(eq(paymentCards.id, id))
      .returning();
    if (!out) throw new RpcError("not_found", "No such card");
    return out;
  }

  async charges(cardIds: string[]) {
    if (cardIds.length === 0) return [];
    return this.db.select().from(paymentCharges).where(inArray(paymentCharges.cardId, cardIds));
  }

  async upsertCharges(rows: ChargeRow[]) {
    for (const row of rows) {
      await this.db
        .insert(paymentCharges)
        .values(row)
        .onConflictDoUpdate({
          target: [paymentCharges.cardId, paymentCharges.ref],
          set: { amountCents: row.amountCents, description: row.description, at: row.at },
        });
    }
  }
}
