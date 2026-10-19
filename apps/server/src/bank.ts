import {
  allowance,
  BankError,
  checkCard,
  type BankPlugin,
  type BudgetCard,
  type CardRef,
  type CardUsage,
  type IssuedCard,
} from "@nibblet/bank";
import {
  formatAmount,
  parseAmount,
  RpcError,
  type AssetInfo,
  type BankProvider,
  type BankProviderId,
  type BankStatus,
  type Card,
  type CardClosedBy,
  type CardFile,
  type CardSecret,
  type CardKind,
  type LiveMessage,
  type SpendingAllowance,
} from "@nibblet/protocol";
import type { CardFiles } from "./card-files.ts";
import { newId, toCard, type CardRow, type Store } from "./store.ts";

/** How often open cards are checked with their providers. */
const SYNC_EVERY_MS = 60_000;
/** How long a card whose issuing didn't answer clearly gets to show up before it's looked for. */
const RECOVER_AFTER_MS = 2 * 60_000;
/** How long one that hasn't shown up is looked for before it's taken as never made. */
const GIVE_UP_AFTER_MS = 60 * 60_000;
/** How long a killed card can stay unsettled before it's recorded as closed anyway. */
const UNSETTLED_AFTER_MS = 24 * 60 * 60_000;

export type BankStore = Pick<
  Store,
  "getNibblet" | "cardsOf" | "cardRow" | "createCard" | "updateCard" | "deleteCard" | "liveCards"
>;

export interface BankDeps {
  store: BankStore;
  plugins: ReadonlyMap<BankProviderId, BankPlugin>;
  /** Plugins whose settings are there but wrong, with why. */
  errors?: ReadonlyMap<BankProviderId, string>;
  files: Pick<CardFiles, "put" | "remove">;
  publish(message: LiveMessage): void;
  log(message: string): void;
  now?(): Date;
}

export interface CardRequest {
  provider: string;
  /** In the asset's own units, e.g. `25.00`. */
  limit: string;
  kind: CardKind;
  purpose: string;
}

/**
 * Nibblets' cards: makes them within each nibblet's spending limits, puts
 * their details in its container, keeps track of what's spent on them, and
 * kills them. The plugins do the talking to providers.
 */
export class Bank {
  private readonly deps: BankDeps;
  /** One card request or kill at a time per nibblet, so two can't both fit the same budget. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Cards whose `issue` is still running, so `sync` doesn't take them for lost. */
  private readonly issuing = new Set<string>();
  /** Where each open card's file is in its container, as its runner last said. */
  private readonly paths = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;

  constructor(deps: BankDeps) {
    this.deps = deps;
  }

  /** Whether any bank is set up, so the tools are worth offering. */
  get enabled(): boolean {
    return this.deps.plugins.size > 0;
  }

  /** The banks nibblets can ask for cards from. */
  providers(): { id: string; label: string; asset: AssetInfo }[] {
    return [...this.deps.plugins.values()].map((p) => ({
      id: p.id,
      label: p.label,
      asset: p.asset,
    }));
  }

  async status(): Promise<BankStatus> {
    const providers = await Promise.all(
      [...this.deps.plugins.values()].map(async (plugin): Promise<BankProvider> => {
        const base = { id: plugin.id, label: plugin.label, asset: plugin.asset };
        try {
          const balance = await plugin.balance();
          return { ...base, state: "ready", detail: null, balance: balance?.toString() ?? null };
        } catch (err) {
          if (!(err instanceof BankError)) this.deps.log(`${plugin.id}: ${message(err)}`);
          const detail =
            err instanceof BankError ? err.message : "It didn't answer; the server's log has why.";
          return { ...base, state: "error", detail, balance: null };
        }
      }),
    );
    const problems = [...(this.deps.errors ?? [])].map(([id, detail]) => ({ id, detail }));
    return { providers, problems };
  }

  async cards(nibbletId: string): Promise<Card[]> {
    return (await this.deps.store.cardsOf(nibbletId)).map(toCard);
  }

  /** Where an open card's file is in its container, if it's been written since the server started. */
  pathOf(cardId: string): string | null {
    return this.paths.get(cardId) ?? null;
  }

  async allowances(nibbletId: string): Promise<SpendingAllowance[]> {
    const nibblet = await this.deps.store.getNibblet(nibbletId);
    const cards = (await this.deps.store.cardsOf(nibbletId)).map(budgetCard);
    const now = this.now();
    return nibblet.spendingLimits.flatMap((limit) => {
      const left = allowance([limit], cards, limit.asset, now);
      return left
        ? [
            {
              limit,
              used: left.used.toString(),
              remaining: left.remaining.toString(),
              since: left.since.toISOString(),
            },
          ]
        : [];
    });
  }

  /**
   * Makes a card for a nibblet and writes it in its container. Its row goes
   * in first, as `pending`, so a card the provider made before something
   * failed is never lost track of: `sync` finds and closes it. A card that
   * can't be written in the container is closed again rather than left open
   * unseen.
   */
  request(
    nibbletId: string,
    request: CardRequest,
  ): Promise<{ card: Card; path: string; details: CardSecret["type"] }> {
    return this.serially(nibbletId, async () => {
      const plugin = this.plugin(request.provider);
      const { decimals, code } = plugin.asset;
      let amount: bigint;
      try {
        amount = parseAmount(request.limit, decimals);
      } catch (err) {
        throw new RpcError("bad_request", message(err));
      }
      const nibblet = await this.deps.store.getNibblet(nibbletId);
      const existing = (await this.deps.store.cardsOf(nibbletId)).map(budgetCard);
      const check = checkCard(nibblet.spendingLimits, existing, code, amount, this.now(), (m) =>
        formatAmount(m, decimals),
      );
      if (!check.ok) throw new RpcError("conflict", check.reason);

      const id = newId("card");
      const purpose = request.purpose.trim();
      await this.deps.store.createCard({
        id,
        nibbletId,
        provider: plugin.id,
        ref: "",
        asset: code,
        decimals,
        kind: request.kind,
        limitMinor: amount.toString(),
        purpose,
        display: "",
        state: "pending",
      });
      this.issuing.add(id);
      let issued: IssuedCard;
      try {
        issued = await plugin.issue({
          cardId: id,
          nibbletId,
          label: `${nibblet.name}: ${purpose}`.slice(0, 120),
          kind: request.kind,
          limit: amount,
        });
      } catch (err) {
        if (err instanceof BankError) {
          // A refusal: nothing was made, so there's nothing to keep.
          await this.deps.store.deleteCard(id);
          throw new RpcError("unavailable", `${plugin.label} refused: ${err.message}`);
        }
        this.deps.log(`issuing card ${id} at ${plugin.id} failed: ${message(err)}`);
        throw new RpcError(
          "unavailable",
          `${plugin.label} didn't answer clearly, so card ${id} is held as pending (counting against your limit) until the server checks whether it was made; if it was, it's closed. Try again in a few minutes.`,
        );
      } finally {
        this.issuing.delete(id);
      }
      const row = await this.deps.store.updateCard(id, {
        ref: issued.ref,
        display: issued.display,
        state: "open",
      });
      const file: CardFile = {
        id,
        provider: plugin.id,
        asset: code,
        kind: request.kind,
        limit: formatAmount(amount, decimals),
        purpose,
        details: issued.secret,
      };
      let path: string;
      try {
        path = await this.deps.files.put(nibbletId, file);
      } catch (err) {
        await this.close(row, plugin, "server").catch((closeErr: unknown) =>
          this.deps.log(
            `couldn't close card ${id} that never reached its container: ${message(closeErr)}`,
          ),
        );
        throw new RpcError(
          "unavailable",
          `The card couldn't be put in your container (${message(err)}), so it was closed again.`,
        );
      }
      this.paths.set(id, path);
      this.changed(nibbletId);
      return { card: toCard(row), path, details: issued.secret.type };
    });
  }

  /**
   * Kills a card for good. `nibbletId` is the nibblet asking, which may only
   * kill its own; the person (null) may kill any. A card that can't be
   * settled yet (a wallet whose funding isn't seen) is left `closing`, and
   * `sync` finishes it.
   */
  async kill(cardId: string, by: CardClosedBy, nibbletId: string | null = null): Promise<Card> {
    const first = await this.deps.store.cardRow(cardId).catch(() => null);
    if (!first || (nibbletId !== null && first.nibbletId !== nibbletId)) {
      throw new RpcError("not_found", `No card ${cardId}${nibbletId ? " of yours" : ""}`);
    }
    return this.serially(first.nibbletId, async () => {
      const row = await this.deps.store.cardRow(cardId);
      if (row.state === "closed") return toCard(row);
      if (row.state === "pending") {
        throw new RpcError(
          "conflict",
          "That card is still being made, or checked on. It'll be closed if it was made; try again in a few minutes.",
        );
      }
      const plugin = this.deps.plugins.get(row.provider);
      if (!plugin) {
        throw new RpcError(
          "unavailable",
          `${row.provider} isn't set up on this server any more, so its card can't be killed from here`,
        );
      }
      return toCard(await this.close(row, plugin, by));
    });
  }

  /**
   * Kills every card a nibblet has, before it's deleted. Throws if any isn't
   * closed afterwards, since deleting the nibblet would lose the only record
   * of a card that can still be spent, or of a wallet's funds.
   */
  async killAll(nibbletId: string): Promise<void> {
    for (const row of await this.deps.store.cardsOf(nibbletId)) {
      if (row.state === "closed" || row.state === "pending") continue;
      await this.kill(row.id, "user").catch((err: unknown) =>
        this.deps.log(`couldn't kill card ${row.id}: ${message(err)}`),
      );
    }
    const left = (await this.deps.store.cardsOf(nibbletId)).filter((r) => r.state !== "closed");
    if (left.length > 0) {
      throw new RpcError(
        "conflict",
        `It still has ${left.length === 1 ? "a card" : `${left.length} cards`} that couldn't be closed (${left.map((r) => r.id).join(", ")}). Kill ${left.length === 1 ? "it" : "them"} in its settings, or wait a few minutes, before deleting it.`,
      );
    }
  }

  /** Writes a nibblet's open cards into its container again, once its runner is back. */
  async restore(nibbletId: string): Promise<void> {
    for (const { id } of await this.deps.store.cardsOf(nibbletId)) {
      await this.serially(nibbletId, async () => {
        // Checked in turn with kills, so a card killed meanwhile isn't written back.
        const row = await this.deps.store.cardRow(id);
        if (row.state !== "open") return;
        const plugin = this.deps.plugins.get(row.provider);
        if (!plugin) return;
        const details = await plugin.reveal(cardRef(row));
        const path = await this.deps.files.put(nibbletId, {
          id: row.id,
          provider: row.provider,
          asset: row.asset,
          kind: row.kind,
          limit: formatAmount(row.limitMinor, row.decimals),
          purpose: row.purpose,
          details,
        });
        this.paths.set(row.id, path);
      }).catch((err: unknown) =>
        this.deps.log(`couldn't put card ${id} back in ${nibbletId}'s container: ${message(err)}`),
      );
    }
  }

  /**
   * Checks every card that isn't closed with its provider: what's been
   * spent, whether the provider closed it, closes single-use cards that have
   * been used, finishes closing ones that weren't settled, and finds out
   * whether pending ones were made.
   */
  sync(): Promise<void> {
    this.syncing ??= this.syncOnce().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async syncOnce(): Promise<void> {
    for (const row of await this.deps.store.liveCards()) {
      const plugin = this.deps.plugins.get(row.provider);
      if (!plugin) continue;
      try {
        await this.serially(row.nibbletId, async () => {
          const current = await this.deps.store.cardRow(row.id);
          if (current.state === "pending") return this.recover(current, plugin);
          if (current.state === "closing") {
            await this.close(current, plugin, current.closedBy ?? "server");
            return;
          }
          if (current.state !== "open") return;
          const usage = await plugin.inspect(cardRef(current));
          if (!usage.open) {
            await this.record(current, usage, "provider");
          } else if (current.kind === "single_use" && usage.used) {
            await this.close(current, plugin, "provider");
          } else {
            const spent = usage.spent.toString();
            await this.deps.store.updateCard(current.id, {
              spentMinor: spent,
              checkedAt: this.now(),
            });
            if (spent !== current.spentMinor) this.changed(current.nibbletId);
          }
        });
      } catch (err) {
        this.deps.log(`couldn't check card ${row.id}: ${message(err)}`);
      }
    }
  }

  /**
   * A card whose issuing didn't answer clearly: once it's had time to show
   * up, either it was made, and is closed (its nibblet was told it failed),
   * or it wasn't, and the row goes.
   */
  private async recover(row: CardRow, plugin: BankPlugin): Promise<void> {
    if (this.issuing.has(row.id)) return;
    const age = this.now().getTime() - row.createdAt.getTime();
    if (age < RECOVER_AFTER_MS) return;
    const found = await plugin.find(row.id);
    if (found) {
      const made = await this.deps.store.updateCard(row.id, {
        ref: found.ref,
        display: found.display,
        state: "closing",
        closedBy: "server",
      });
      this.deps.log(`card ${row.id} was made after all; closing it`);
      await this.close(made, plugin, "server");
    } else if (age >= GIVE_UP_AFTER_MS) {
      this.deps.log(`card ${row.id} was never made; forgetting it`);
      await this.deps.store.deleteCard(row.id);
      this.changed(row.nibbletId);
    }
  }

  /**
   * Closes a card at its provider. Until the provider says it's settled, it
   * stays `closing` (and counts in full), and `sync` tries again; after a
   * day it's recorded as closed anyway, with a warning, since its id (and so
   * a wallet's key) is still in its row.
   */
  private async close(row: CardRow, plugin: BankPlugin, by: CardClosedBy): Promise<CardRow> {
    if (row.state !== "closing") {
      row = await this.deps.store.updateCard(row.id, { state: "closing", closedBy: by });
      this.paths.delete(row.id);
      await this.deps.files.remove(row.nibbletId, row.id).catch(() => undefined);
      this.changed(row.nibbletId);
    }
    const result = await this.guard(plugin, "close the card", () => plugin.close(cardRef(row)));
    const stale = this.now().getTime() - row.createdAt.getTime() >= UNSETTLED_AFTER_MS;
    if (!result.settled && !stale) {
      return this.deps.store.updateCard(row.id, {
        spentMinor: result.spent.toString(),
        checkedAt: this.now(),
      });
    }
    if (!result.settled) {
      this.deps.log(`card ${row.id} at ${plugin.id} never settled; recording it as closed anyway`);
    }
    return this.record(row, result, by);
  }

  /** Stores a card as closed and takes its file out of its container. */
  private async record(row: CardRow, usage: CardUsage, by: CardClosedBy): Promise<CardRow> {
    const closed = await this.deps.store.updateCard(row.id, {
      state: "closed",
      closedBy: by,
      closedAt: this.now(),
      checkedAt: this.now(),
      spentMinor: usage.spent.toString(),
    });
    this.paths.delete(row.id);
    // It's dead either way; a container that's asleep has no file to remove.
    // One that was closing has had its file removed already.
    if (row.state !== "closing") {
      await this.deps.files.remove(row.nibbletId, row.id).catch(() => undefined);
    }
    this.changed(row.nibbletId);
    return closed;
  }

  /**
   * Runs a plugin call, passing on only errors meant to be shown: anything
   * else could carry a credential (an RPC URL with its key, say), so it's
   * logged here and reported plainly.
   */
  private async guard<T>(plugin: BankPlugin, doing: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof RpcError) throw err;
      if (err instanceof BankError)
        throw new RpcError("unavailable", `${plugin.label}: ${err.message}`);
      this.deps.log(`${plugin.id} couldn't ${doing}: ${message(err)}`);
      throw new RpcError(
        "unavailable",
        `${plugin.label} couldn't ${doing} just now; the server's log has the details.`,
      );
    }
  }

  private plugin(id: string): BankPlugin {
    const plugin = this.deps.plugins.get(id);
    if (plugin) return plugin;
    const known = [...this.deps.plugins.keys()];
    throw new RpcError(
      "bad_request",
      known.length
        ? `No bank called ${id}. This server has: ${known.join(", ")}.`
        : "No bank is set up on this server.",
    );
  }

  private serially<T>(nibbletId: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(nibbletId) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(nibbletId, settled);
    void settled.then(() => {
      if (this.queues.get(nibbletId) === settled) this.queues.delete(nibbletId);
    });
    return next;
  }

  private changed(nibbletId: string): void {
    this.deps.publish({ type: "cards_changed", nibbletId });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function cardRef(row: CardRow): CardRef {
  return { id: row.id, ref: row.ref, kind: row.kind, limit: BigInt(row.limitMinor) };
}

function budgetCard(row: CardRow): BudgetCard {
  return {
    asset: row.asset,
    limit: BigInt(row.limitMinor),
    spent: BigInt(row.spentMinor),
    // Pending and closing cards could still be spent, or still hold funds.
    open: row.state !== "closed",
    createdAt: row.createdAt,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
