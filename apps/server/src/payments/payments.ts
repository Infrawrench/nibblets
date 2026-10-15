import {
  defaultPaymentPolicy,
  formatMoney,
  PaymentPolicy,
  RpcError,
  SECRET_FILES_DIR,
  type CardPurpose,
  type CardStatus,
  type IssuedCard,
  type JsonValue,
  type LiveMessage,
  type NibbletPayments,
  type PaymentAccount,
  type PaymentPermission,
  type PaymentProviderInfo,
  type SetupField,
  type SpendPeriod,
} from "@nibblet/protocol";
import { randomBytes } from "node:crypto";
import type { Decision } from "../approvals.ts";
import { declinedText } from "../approvals.ts";
import { committed, periodStart, totalSpent, type LedgerCard } from "./ledger.ts";
import { PaymentError, type CardDetails, type ProviderAccount } from "./provider.ts";
import type { PaymentRegistry } from "./registry.ts";
import type { AccountRow, CardRow, ChargeRow, PaymentsRepo } from "./repo.ts";

/** What payments need from the rest of the server: asking the person, and the nibblet's container. */
export interface PaymentsGateway {
  approve(
    nibbletId: string,
    call: { server: string; tool: string; input: JsonValue },
  ): Promise<Decision>;
  /** Writes (or, with null, removes) a secret file in the nibblet's container; returns its path. */
  writeSecret(nibbletId: string, name: string, content: string | null): Promise<string | null>;
  /** A line in the nibblet's thread, for things that happen to its cards on their own. */
  notice(nibbletId: string, text: string): Promise<void>;
  publish(message: LiveMessage): void;
}

export interface PaymentsOptions {
  now?: () => Date;
  /** How long after a one-time card's first charge it's closed, so a checkout can finish. */
  graceMs?: number;
  log?: (message: string) => void;
}

/** A one-time card is closed this long after its first charge: long enough for a verification hold and the real charge. */
const DEFAULT_GRACE_MS = 15 * 60_000;
const POLL_MS = 5 * 60_000;
/** Closed cards are still watched this long, for late charges and refunds. */
const WATCH_CLOSED_MS = 35 * 86_400_000;
const DESCRIBE_TTL_MS = 60_000;
export const DEFAULT_VALID_DAYS = 7;
export const MAX_VALID_DAYS = 30;

interface AccountStatus {
  ok: boolean;
  detail: string | null;
  summary: string[];
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export interface CardRequestInput {
  purpose: CardPurpose;
  /** For a one-time card: what it's for. Recurring cards take the rest of the limit. */
  amountCents?: number;
  description: string;
  accountId?: string;
  validDays?: number;
}

/**
 * Payment accounts, nibblets' limits and access, and the cards they ask
 * for. A card is issued only for an account the nibblet may use (asking the
 * person first where it's set to Ask), only within what's left of its
 * limit, and its details go straight to a file in the nibblet's container.
 */
export class Payments {
  private readonly repo: PaymentsRepo;
  private readonly registry: PaymentRegistry;
  private readonly gateway: PaymentsGateway;
  private readonly now: () => Date;
  private readonly graceMs: number;
  private readonly log: (message: string) => void;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly described = new Map<string, { at: number; value: AccountStatus }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;

  constructor(
    repo: PaymentsRepo,
    registry: PaymentRegistry,
    gateway: PaymentsGateway,
    opts: PaymentsOptions = {},
  ) {
    this.repo = repo;
    this.registry = registry;
    this.gateway = gateway;
    this.now = opts.now ?? (() => new Date());
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  start(): void {
    this.timer ??= setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Accounts

  providers(): PaymentProviderInfo[] {
    return this.registry.visible();
  }

  async accounts(): Promise<PaymentAccount[]> {
    const rows = await this.repo.accounts();
    return Promise.all(rows.map((r) => this.toAccount(r)));
  }

  async setup(input: {
    provider: string;
    accountId?: string;
    credentials?: Record<string, string>;
  }): Promise<SetupField[]> {
    const provider = this.provider(input.provider);
    const existing = input.accountId ? await this.accountRow(input.accountId) : null;
    const credentials = { ...existing?.credentials, ...clean(input.credentials ?? {}) };
    checkCredentials(provider.credentialFields, credentials);
    return this.friendly(() => provider.setup(credentials, existing?.config ?? {}));
  }

  async addAccount(input: {
    provider: string;
    label: string;
    credentials: Record<string, string>;
    config: Record<string, string>;
  }): Promise<PaymentAccount> {
    const provider = this.provider(input.provider);
    const credentials = clean(input.credentials);
    checkCredentials(provider.credentialFields, credentials);
    const fields = await this.friendly(() => provider.setup(credentials, {}));
    const row = await this.repo.insertAccount({
      id: newId("pay"),
      provider: provider.id,
      label: input.label.trim(),
      credentials: pick(credentials, provider.credentialFields),
      config: checkConfig(fields, input.config),
    });
    return this.toAccount(row);
  }

  async updateAccount(input: {
    id: string;
    label?: string;
    credentials?: Record<string, string>;
    config?: Record<string, string>;
  }): Promise<PaymentAccount> {
    const row = await this.accountRow(input.id);
    const provider = this.provider(row.provider);
    const credentials = pick(
      { ...row.credentials, ...clean(input.credentials ?? {}) },
      provider.credentialFields,
    );
    let config = row.config;
    if (input.credentials || input.config) {
      checkCredentials(provider.credentialFields, credentials);
      const fields = await this.friendly(() => provider.setup(credentials, row.config));
      config = checkConfig(fields, { ...row.config, ...input.config });
    }
    this.described.delete(row.id);
    return this.toAccount(
      await this.repo.updateAccount(row.id, {
        ...(input.label ? { label: input.label.trim() } : {}),
        credentials,
        config,
      }),
    );
  }

  /** Cancels its live cards, takes it away from every nibblet, then forgets it. */
  async removeAccount(id: string): Promise<void> {
    const row = await this.accountRow(id);
    for (const { nibbletId } of await this.repo.policies()) {
      for (const card of await this.repo.cards(nibbletId)) {
        if (card.accountId === id && card.status === "active") {
          await this.close(card, "cancelled", "Its payment account was removed", { force: true });
        }
      }
    }
    for (const { nibbletId, policy } of await this.repo.policies()) {
      if (!(id in policy.access)) continue;
      const access = { ...policy.access };
      delete access[id];
      await this.repo.setPolicy(nibbletId, { ...policy, access });
      this.changed(nibbletId);
    }
    this.described.delete(row.id);
    await this.repo.deleteAccount(id);
  }

  // A nibblet's limit and cards

  async overview(nibbletId: string): Promise<NibbletPayments> {
    const policy = await this.repo.policy(nibbletId);
    const cards = await this.repo.cards(nibbletId);
    const ledger = await this.ledger(cards);
    const since = periodStart(policy.period, this.now());
    const used = committed([...ledger.values()], since);
    return {
      nibbletId,
      policy,
      committedCents: used,
      remainingCents: Math.max(0, policy.limitCents - used),
      periodStart: since?.toISOString() ?? null,
      cards: cards
        .map((c) => toIssuedCard(c, ledger.get(c.id)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async setPolicy(input: {
    nibbletId: string;
    limitCents?: number;
    period?: SpendPeriod;
    access?: Record<string, PaymentPermission>;
  }): Promise<NibbletPayments> {
    await this.lock(input.nibbletId, async () => {
      const policy = await this.repo.policy(input.nibbletId);
      const access = { ...policy.access };
      for (const [accountId, permission] of Object.entries(input.access ?? {})) {
        if (permission === "none") {
          delete access[accountId];
          continue;
        }
        await this.accountRow(accountId);
        access[accountId] = permission;
      }
      await this.repo.setPolicy(
        input.nibbletId,
        PaymentPolicy.parse({
          limitCents: input.limitCents ?? policy.limitCents,
          period: input.period ?? policy.period,
          access,
        }),
      );
    });
    this.changed(input.nibbletId);
    return this.overview(input.nibbletId);
  }

  /** The person cancelling a card from the UI. */
  async cancelByPerson(cardId: string): Promise<NibbletPayments> {
    const card = await this.repo.card(cardId);
    if (!card) throw new RpcError("not_found", "No such card");
    if (card.status === "active") {
      await this.close(card, "cancelled", "Cancelled by you", { force: false });
      await this.gateway.notice(
        card.nibbletId,
        `Your person cancelled card ••${card.lastFour} (${card.description}).`,
      );
    }
    return this.overview(card.nibbletId);
  }

  /** Before a nibblet is deleted: nothing it held stays open. */
  async forgetNibblet(nibbletId: string): Promise<void> {
    for (const card of await this.repo.cards(nibbletId)) {
      if (card.status === "active") {
        await this.close(card, "cancelled", "The nibblet was deleted", { force: true });
      }
    }
  }

  // What nibblets use

  /** The accounts a nibblet may use, with what it's allowed. */
  async usable(nibbletId: string): Promise<{ account: AccountRow; permission: "allow" | "ask" }[]> {
    const policy = await this.repo.policy(nibbletId);
    const rows = await this.repo.accounts();
    return rows.flatMap((account) => {
      const permission = policy.access[account.id];
      const provider = this.registry.get(account.provider);
      if (!permission || !provider || provider.hidden) return [];
      return [{ account, permission }];
    });
  }

  /** What the `payment_methods` tool returns. */
  async describeFor(nibbletId: string) {
    const overview = await this.overview(nibbletId);
    const methods = await this.usable(nibbletId);
    const currency = (accountId: string | null) =>
      this.registry.get(methods.find((m) => m.account.id === accountId)?.account.provider ?? "")
        ?.currency ?? "USD";
    return {
      limit: formatMoney(overview.policy.limitCents),
      period: overview.policy.period === "monthly" ? "each calendar month (UTC)" : "in all",
      committed: formatMoney(overview.committedCents),
      remaining: formatMoney(overview.remainingCents),
      methods: methods.map(({ account, permission }) => ({
        id: account.id,
        label: account.label,
        kind: this.registry.get(account.provider)?.kind,
        provider: this.registry.get(account.provider)?.label,
        approval: permission === "ask" ? "your person approves each card" : "not needed",
      })),
      cards: overview.cards.map((c) => ({
        id: c.id,
        purpose: c.purpose,
        for: c.description,
        lastFour: c.lastFour,
        limit: formatMoney(c.limitCents, currency(c.accountId)),
        spent: formatMoney(c.spentCents, currency(c.accountId)),
        status: c.status,
        ...(c.status === "active"
          ? { file: secretPath(cardFileName(c.id)), expiresAt: c.expiresAt }
          : { closed: c.closedReason }),
      })),
    };
  }

  /**
   * Issues a card to a nibblet, if it may have one: returns the card and
   * where its details are. Throws a `PaymentError` saying why not.
   */
  async requestCard(
    nibbletId: string,
    input: CardRequestInput,
  ): Promise<{ card: IssuedCard; path: string; note: string | null }> {
    const { account, permission } = await this.chooseAccount(nibbletId, input.accountId);
    const provider = this.registry.card(account.provider);
    if (!provider) throw new PaymentError(`${account.label} doesn't issue cards`);
    const description = input.description.trim().slice(0, 200);
    const before = await this.overview(nibbletId);
    const asked = this.amountFor(input, before.remainingCents, before.policy);

    if (permission === "ask") {
      const decision = await this.gateway.approve(nibbletId, {
        server: "payments",
        tool: input.purpose === "once" ? "card_once" : "card_recurring",
        input: {
          account: account.label,
          card: input.purpose === "once" ? "one purchase" : "recurring",
          amount: formatMoney(asked, provider.currency),
          for: description,
          leftAfter: formatMoney(before.remainingCents - asked, provider.currency),
        },
      });
      if (!decision.approved) throw new PaymentError(declinedText(decision));
    }

    return this.lock(nibbletId, async () => {
      // Check again: other cards may have gone out while the person decided.
      const now = await this.overview(nibbletId);
      const amount = Math.min(asked, this.amountFor(input, now.remainingCents, now.policy));
      const policy = now.policy;
      const validDays = Math.min(
        MAX_VALID_DAYS,
        Math.max(1, input.validDays ?? DEFAULT_VALID_DAYS),
      );
      const id = newId("card");
      const issued = await this.friendly(async () =>
        provider.issue(this.providerAccount(account), {
          purpose: input.purpose,
          amountCents: amount,
          // A one-time card a person approved shouldn't come out bigger than asked.
          maxCents: input.purpose === "once" && permission === "ask" ? amount : now.remainingCents,
          interval:
            input.purpose === "recurring" && policy.period === "monthly" ? "monthly" : "yearly",
          nickname: `Nibblet ${input.purpose === "once" ? "one-time" : "recurring"}: ${description}`,
          inUse: await this.repo.activeRefs(provider.id),
        }),
      );
      const row = await this.repo.insertCard({
        id,
        nibbletId,
        accountId: account.id,
        provider: provider.id,
        providerRef: issued.ref,
        purpose: input.purpose,
        source: issued.source,
        lastFour: issued.lastFour,
        limitCents: issued.limitCents,
        description,
        status: "active",
        closedReason: null,
        fileName: cardFileName(id),
        createdAt: this.now(),
        expiresAt:
          input.purpose === "once" ? new Date(this.now().getTime() + validDays * 86_400_000) : null,
        firstChargeAt: null,
        closedAt: null,
      });
      let path: string | null;
      try {
        path = await this.gateway.writeSecret(
          nibbletId,
          row.fileName,
          cardFile(row, issued.details, provider.currency),
        );
      } catch (err) {
        await this.close(row, "cancelled", "Couldn't hand its details over", { force: true });
        throw new PaymentError(
          `The card was cancelled because its details couldn't be saved for you: ${message(err)}`,
        );
      }
      this.changed(nibbletId);
      return {
        card: toIssuedCard(row, { status: "active", limitCents: row.limitCents, charges: [] }),
        path: path ?? secretPath(row.fileName),
        note: issued.note ?? null,
      };
    });
  }

  /** A nibblet deleting one of its own cards. */
  async deleteCard(nibbletId: string, cardId: string): Promise<IssuedCard> {
    const card = await this.repo.card(cardId);
    if (!card || card.nibbletId !== nibbletId) throw new PaymentError(`You have no card ${cardId}`);
    const closed =
      card.status === "active"
        ? await this.close(card, "cancelled", "Deleted by the nibblet", { force: false })
        : card;
    const ledger = await this.ledger([closed]);
    return toIssuedCard(closed, ledger.get(closed.id));
  }

  /** The system prompt's section on payments, or null when it has none. */
  async promptSection(nibbletId: string): Promise<string | null> {
    const methods = await this.usable(nibbletId);
    if (methods.length === 0) return null;
    const o = await this.overview(nibbletId);
    const lines = methods.map(
      ({ account, permission }) =>
        `- ${account.label} (\`${account.id}\`, ${this.registry.get(account.provider)?.label} cards${permission === "ask" ? ", your person approves each card" : ""})`,
    );
    const live = o.cards.filter((c) => c.status === "active");
    return [
      "## Payments",
      `You can pay for things with cards from these accounts:\n${lines.join("\n")}`,
      `Your spending limit is ${formatMoney(o.policy.limitCents)} ${o.policy.period === "monthly" ? "a month" : "in all"}; ${formatMoney(o.remainingCents)} is left. Every live card holds its whole limit until it's closed.`,
      "Ask for a card only when you're about to pay: `card_once` for a single purchase (it's closed shortly after it's charged, or after a few days unused), `card_recurring` for a subscription (it gets everything that's left of your limit, so ask for it last). The details are written to a file whose path the tool returns: read them from there when you fill in a checkout, and never copy the number, expiry or CVC into the chat, your memory, other files, or your status. Delete cards you no longer need with `card_delete`; `payment_methods` shows what you have.",
      live.length
        ? `Your live cards: ${live.map((c) => `••${c.lastFour} for ${c.description} (\`${c.id}\`, ${c.purpose})`).join("; ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Writes a nibblet's live cards to its container again, after it's restarted and lost them. */
  async redeliver(nibbletId: string): Promise<void> {
    for (const card of await this.repo.cards(nibbletId)) {
      if (card.status !== "active" || !card.accountId) continue;
      try {
        const account = await this.accountRow(card.accountId);
        const provider = this.registry.card(card.provider);
        if (!provider) continue;
        const details = await provider.reveal(this.providerAccount(account), card.providerRef);
        await this.gateway.writeSecret(
          nibbletId,
          card.fileName,
          cardFile(card, details, provider.currency),
        );
      } catch (err) {
        this.log(
          `[${nibbletId}] couldn't hand card ••${card.lastFour} over again: ${message(err)}`,
        );
      }
    }
  }

  // Watching cards

  /** Brings charges up to date and closes cards that are done. Runs every few minutes. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const now = this.now();
    const watched = await this.repo.watchedCards(new Date(now.getTime() - WATCH_CLOSED_MS));
    const byAccount = new Map<string, CardRow[]>();
    for (const card of watched) {
      if (!card.accountId) continue;
      byAccount.set(card.accountId, [...(byAccount.get(card.accountId) ?? []), card]);
    }
    const touched = new Set<string>();
    for (const [accountId, cards] of byAccount) {
      const account = await this.repo.account(accountId);
      const provider = account ? this.registry.card(account.provider) : null;
      if (!account || !provider) continue;
      const since = new Date(Math.min(...cards.map((c) => c.createdAt.getTime())) - 86_400_000);
      try {
        const charges = await provider.charges(
          this.providerAccount(account),
          cards.map((c) => c.providerRef),
          since,
        );
        const cardFor = new Map(cards.map((c) => [c.providerRef, c]));
        const rows: ChargeRow[] = charges.flatMap((ch) => {
          const card = cardFor.get(ch.cardRef);
          return card
            ? [
                {
                  cardId: card.id,
                  ref: ch.ref,
                  amountCents: ch.amountCents,
                  description: ch.description,
                  at: ch.at,
                },
              ]
            : [];
        });
        const before = await this.repo.charges(cards.map((c) => c.id));
        await this.repo.upsertCharges(rows);
        for (const row of rows) {
          const old = before.find((b) => b.cardId === row.cardId && b.ref === row.ref);
          if (!old || old.amountCents !== row.amountCents) {
            const card = cards.find((c) => c.id === row.cardId);
            if (card) touched.add(card.nibbletId);
          }
        }
      } catch (err) {
        this.log(`couldn't check charges on ${account.label}: ${message(err)}`);
        continue;
      }
      for (const card of cards) {
        if (card.status !== "active") continue;
        if (await this.settle(card, now)) touched.add(card.nibbletId);
      }
    }
    for (const nibbletId of touched) this.changed(nibbletId);
  }

  /** Closes a live card that's done with; true if anything changed. */
  private async settle(card: CardRow, now: Date): Promise<boolean> {
    const charges = await this.repo.charges([card.id]);
    const spent = totalSpent({ charges });
    const first = charges
      .filter((c) => c.amountCents > 0)
      .reduce<Date | null>((min, c) => (min === null || c.at < min ? c.at : min), null);
    let current = card;
    if (first && !card.firstChargeAt) {
      current = await this.repo.updateCard(card.id, { firstChargeAt: first });
    }
    if (card.purpose === "once") {
      if (first && now.getTime() - first.getTime() >= this.graceMs) {
        await this.close(current, "used", `Closed after its purchase (${formatMoney(spent)})`, {
          force: false,
        });
        await this.gateway.notice(
          card.nibbletId,
          `Card ••${card.lastFour} (${card.description}) was charged ${formatMoney(spent)} and has been closed.`,
        );
        return true;
      }
      if (!first && card.expiresAt && card.expiresAt <= now) {
        await this.close(current, "expired", "Not used in time", { force: false });
        await this.gateway.notice(
          card.nibbletId,
          `Card ••${card.lastFour} (${card.description}) wasn't used, so it has been closed.`,
        );
        return true;
      }
      return current !== card;
    }
    // A recurring card on an all-time limit is done once it's spent its share.
    const policy = await this.repo.policy(card.nibbletId).catch(() => defaultPaymentPolicy);
    if (policy.period === "all_time" && spent >= card.limitCents) {
      await this.close(current, "used", "Spent its whole limit", { force: false });
      await this.gateway.notice(
        card.nibbletId,
        `Recurring card ••${card.lastFour} (${card.description}) has spent its whole limit and has been closed.`,
      );
      return true;
    }
    return current !== card;
  }

  // Internals

  /**
   * Cancels a card with its provider, then marks it closed and removes its
   * file. If the provider can't be reached it stays open (and counted),
   * unless `force`: for when its nibblet or account is going anyway.
   */
  private async close(
    card: CardRow,
    status: Exclude<CardStatus, "active">,
    reason: string,
    opts: { force: boolean },
  ): Promise<CardRow> {
    const account = card.accountId ? await this.repo.account(card.accountId) : null;
    const provider = this.registry.card(card.provider);
    if (account && provider) {
      try {
        await provider.cancel(this.providerAccount(account), card.providerRef);
      } catch (err) {
        if (!opts.force) {
          throw new PaymentError(`Couldn't cancel card ••${card.lastFour}: ${message(err)}`);
        }
        this.log(`couldn't cancel card ••${card.lastFour} with ${provider.label}: ${message(err)}`);
      }
    }
    const closed = await this.repo.updateCard(card.id, {
      status,
      closedReason: reason,
      closedAt: this.now(),
    });
    await this.gateway.writeSecret(card.nibbletId, card.fileName, null).catch(() => undefined);
    this.changed(card.nibbletId);
    return closed;
  }

  private amountFor(input: CardRequestInput, left: number, policy: PaymentPolicy): number {
    if (policy.limitCents === 0) {
      throw new PaymentError(
        "Your spending limit is $0. Ask your person to set one in your settings.",
      );
    }
    if (input.purpose === "recurring") {
      if (left <= 0)
        throw new PaymentError(
          `You have nothing left of your ${formatMoney(policy.limitCents)} limit.`,
        );
      return left;
    }
    const amount = input.amountCents ?? 0;
    if (amount <= 0) throw new PaymentError("Say how much the purchase is.");
    if (amount > left) {
      throw new PaymentError(
        `That's more than you have left: ${formatMoney(left)} of your ${formatMoney(policy.limitCents)} limit${policy.period === "monthly" ? " this month" : ""}. Delete cards you don't need, or ask your person to raise it.`,
      );
    }
    return amount;
  }

  private async chooseAccount(nibbletId: string, accountId?: string) {
    const usable = (await this.usable(nibbletId)).filter(
      (u) => this.registry.get(u.account.provider)?.kind === "card",
    );
    if (accountId) {
      const found = usable.find((u) => u.account.id === accountId);
      if (!found)
        throw new PaymentError(
          `You can't use payment method ${accountId}. Check \`payment_methods\`.`,
        );
      return found;
    }
    // Ones it can use without asking come first.
    const chosen = usable.find((u) => u.permission === "allow") ?? usable[0];
    if (!chosen) {
      throw new PaymentError(
        "You haven't been given any card accounts. Ask your person to allow one in your settings.",
      );
    }
    return chosen;
  }

  private async ledger(cards: CardRow[]): Promise<Map<string, LedgerCard>> {
    const charges = await this.repo.charges(cards.map((c) => c.id));
    return new Map(
      cards.map((c) => [
        c.id,
        {
          status: c.status,
          limitCents: c.limitCents,
          charges: charges.filter((ch) => ch.cardId === c.id),
        },
      ]),
    );
  }

  private provider(id: string) {
    const provider = this.registry.get(id);
    if (!provider || provider.hidden)
      throw new RpcError("bad_request", `No payment provider ${id}`);
    return provider;
  }

  private async accountRow(id: string): Promise<AccountRow> {
    const row = await this.repo.account(id);
    if (!row) throw new RpcError("not_found", "No such payment account");
    return row;
  }

  private providerAccount(row: AccountRow): ProviderAccount {
    return { id: row.id, label: row.label, credentials: row.credentials, config: row.config };
  }

  private async describe(row: AccountRow): Promise<AccountStatus> {
    const cached = this.described.get(row.id);
    if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.value;
    const provider = this.registry.get(row.provider);
    const value = provider
      ? await provider.describe(this.providerAccount(row)).catch((err: unknown) => ({
          ok: false,
          detail: message(err),
          summary: [] as string[],
        }))
      : {
          ok: false,
          detail: `${row.provider} isn't supported by this server any more`,
          summary: [],
        };
    this.described.set(row.id, { at: Date.now(), value });
    return value;
  }

  private async toAccount(row: AccountRow): Promise<PaymentAccount> {
    const provider = this.registry.get(row.provider);
    const status = await this.describe(row);
    return {
      id: row.id,
      provider: row.provider,
      kind: provider?.kind ?? "card",
      label: row.label,
      currency: provider?.currency ?? "USD",
      config: row.config,
      ok: status.ok,
      detail: status.detail,
      summary: status.summary,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Runs a provider call, turning its errors into ones the UI shows as they are. */
  private async friendly<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PaymentError || err instanceof RpcError) throw err;
      throw new PaymentError(message(err));
    }
  }

  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  private changed(nibbletId: string): void {
    this.gateway.publish({ type: "payments_changed", nibbletId });
  }
}

function toIssuedCard(row: CardRow, ledger: LedgerCard | undefined): IssuedCard {
  return {
    id: row.id,
    nibbletId: row.nibbletId,
    accountId: row.accountId,
    purpose: row.purpose,
    source: row.source,
    lastFour: row.lastFour,
    limitCents: row.limitCents,
    spentCents: ledger ? totalSpent(ledger) : 0,
    description: row.description,
    status: row.status,
    closedReason: row.closedReason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

export function cardFileName(cardId: string): string {
  return `${cardId}.json`;
}

export function secretPath(name: string): string {
  return `${SECRET_FILES_DIR}/${name}`;
}

/** The file a nibblet reads its card from. */
export function cardFile(row: CardRow, details: CardDetails, currency: string): string {
  const yy = String(details.expYear).slice(-2);
  const mm = String(details.expMonth).padStart(2, "0");
  return `${JSON.stringify(
    {
      card: row.id,
      for: row.description,
      purpose: row.purpose,
      number: details.number,
      expiry: `${mm}/${yy}`,
      expMonth: details.expMonth,
      expYear: details.expYear,
      cvc: details.cvc,
      nameOnCard: details.nameOnCard,
      limit: formatMoney(row.limitCents, currency),
      currency,
      use:
        row.purpose === "once"
          ? `For one purchase of up to ${formatMoney(row.limitCents, currency)}. It's closed shortly after it's charged${row.expiresAt ? `, or on ${row.expiresAt.toISOString().slice(0, 10)} if unused` : ""}.`
          : `For a recurring payment of up to ${formatMoney(row.limitCents, currency)}. Delete it with card_delete when the subscription ends.`,
      rules:
        "Type these details only into the checkout they're for. Never copy them into the chat, memory, other files or your status.",
    },
    null,
    2,
  )}\n`;
}

function checkCredentials(fields: SetupField[], credentials: Record<string, string>): void {
  for (const f of fields) {
    if (f.required && !credentials[f.key] && !f.default) {
      throw new RpcError("bad_request", `${f.label} is needed`);
    }
    if (!credentials[f.key] && f.default) credentials[f.key] = f.default;
  }
}

/** Only the setup form's own keys, each required one filled, each choice one it offered. */
function checkConfig(fields: SetupField[], config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const value = (config[f.key] ?? f.default ?? "").trim();
    if (!value) {
      if (f.required) throw new RpcError("bad_request", `Choose ${f.label.toLowerCase()}`);
      continue;
    }
    if (f.type === "select" && !f.options.some((o) => o.value === value)) {
      throw new RpcError("bad_request", `That ${f.label.toLowerCase()} isn't one of the choices`);
    }
    out[f.key] = value;
  }
  return out;
}

function pick(values: Record<string, string>, fields: SetupField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const value = values[f.key];
    if (value) out[f.key] = value;
  }
  return out;
}

/** Drops blank values, so an untouched field keeps what's saved. */
function clean(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v.length > 0),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
