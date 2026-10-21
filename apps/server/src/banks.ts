import {
  BankError,
  changedLockedFields,
  loadBankPlugins,
  maskSettings,
  mergeSettings,
  newBankId,
  resolveBanks,
  type BankDeps,
  type BankPlugin,
  type BankPluginFactory,
  type BankSettingValues,
  type HookRequest,
  type HookResponse,
  type ResolvedBank,
  type SavedBank,
} from "@nibblet/bank";
import { bitcoin } from "@nibblet/bank-bitcoin";
import { ethereum } from "@nibblet/bank-ethereum";
import { slash } from "@nibblet/bank-slash";
import { stripe } from "@nibblet/bank-stripe";
import {
  BankName,
  BankProviderId,
  BankSettings,
  ProxyUrl,
  RpcError,
  type BankStatus,
  type PublicAddress,
} from "@nibblet/protocol";
import { z } from "zod";
import type { Bank } from "./bank.ts";
import type { CardRow, Store } from "./store.ts";
import type { Tunnel } from "./tunnel.ts";

/**
 * Every bank plugin the server knows. Banks are set up with them in
 * Settings, which keeps their settings in the database; there can be
 * several on one plugin (two Slash accounts, say). A plugin with no bank
 * saved under its own id can also have one from the server's environment
 * (variables named like its fields; see `docker/compose.yaml`).
 */
export const BANK_PLUGINS: readonly BankPluginFactory[] = [slash, stripe, bitcoin, ethereum];

const SETTING = "banks";
/** The person's reverse proxy's address, if the server is behind one. */
const PROXY_SETTING = "publicProxy";
const Saved = z.array(
  z.object({ id: BankProviderId, kind: BankProviderId, name: BankName, settings: BankSettings }),
);

export interface BanksDeps {
  store: Pick<Store, "getSetting" | "setSetting" | "deleteSetting"> & {
    liveCards(): Promise<readonly Pick<CardRow, "provider">[]>;
  };
  bank: Pick<Bank, "status" | "use" | "purchase">;
  /** Linking to Nibblets Connect runs it, which reaches this server from the internet. */
  tunnel: Pick<Tunnel, "current">;
  env: BankSettingValues;
  factories?: readonly BankPluginFactory[];
  plugin?: BankDeps;
  log?(message: string): void;
}

export interface BankChange {
  /** Null to set a new bank up. */
  id: string | null;
  kind: string;
  name: string;
  settings: BankSettings;
}

/**
 * Which banks are set up, and setting them up: their settings, checked with
 * their providers before they're saved, then loaded into the `Bank` without
 * a restart. Each plugin describes its own form (`fields`), so nothing here
 * or in the web app knows one bank from another.
 */
export class Banks {
  private readonly deps: BanksDeps;
  private readonly factories: readonly BankPluginFactory[];
  private readonly plugin: BankDeps;
  private readonly log: (message: string) => void;
  /** One change at a time, so two saves can't each write over the other's. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The banks as last loaded, to know which are on which plugin. */
  private loaded: readonly ResolvedBank[] = [];

  constructor(deps: BanksDeps) {
    this.deps = deps;
    this.factories = deps.factories ?? BANK_PLUGINS;
    this.log = deps.log ?? ((message) => console.warn(`bank: ${message}`));
    this.plugin = deps.plugin ?? { fetch: globalThis.fetch, log: this.log };
  }

  /** Loads every bank as it's set up now into the `Bank`. */
  async load(): Promise<void> {
    const banks = await this.banks();
    const { plugins, errors } = loadBankPlugins(this.factories, banks, this.plugin);
    this.loaded = banks;
    for (const plugin of plugins.values()) console.log(`bank: ${plugin.label} is set up`);
    for (const [id, problem] of errors) this.log(`${id} isn't set up: ${problem}`);
    this.deps.bank.use(plugins, errors);
  }

  async status(): Promise<BankStatus> {
    const [health, banks, live, address] = await Promise.all([
      this.deps.bank.status(),
      this.banks(),
      this.deps.store.liveCards(),
      this.publicAddress(),
    ]);
    return {
      ...health,
      publicAddress: address,
      kinds: this.factories.map((f) => ({
        id: f.id,
        name: f.name,
        about: f.about,
        instrument: f.instrument,
        fields: [...f.fields],
        purchaseHook: f.purchaseHook
          ? {
              url: address.url ? `${address.url}${purchasePath(f.id)}` : null,
              where: f.purchaseHook.where,
            }
          : null,
      })),
      banks: banks.map((b) => ({
        id: b.id,
        kind: b.kind,
        name: b.name,
        source: b.source,
        // A bank whose plugin has gone shows no settings, rather than its secrets.
        settings: maskSettings(
          this.factories.find((f) => f.id === b.kind)?.fields ?? [],
          b.settings,
        ),
        liveCards: live.filter((c) => c.provider === b.id).length,
      })),
    };
  }

  /** Checks the settings with the provider, saves them, and loads the bank with them. */
  configure(change: BankChange): Promise<BankStatus> {
    return this.serially(async () => {
      const factory = this.factory(change.kind);
      const banks = await this.banks();
      const existing = change.id === null ? null : this.bank(banks, change.id);
      if (existing && existing.kind !== factory.id) {
        throw new RpcError("bad_request", `${change.id} isn't a ${factory.name} bank`);
      }
      const name = change.name.trim();
      const others = banks.filter((b) => b.kind === factory.id && b.id !== existing?.id);
      // One bank on a plugin can go without a name; the rest need one to tell them apart.
      if (!name && others.some((b) => !b.name)) {
        throw new RpcError(
          "bad_request",
          `Give it a name, to tell it from your other ${factory.name} bank${others.length === 1 ? "" : "s"}`,
        );
      }
      if (name && others.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
        throw new RpcError("conflict", `There's already a ${factory.name} bank called ${name}`);
      }
      const current = existing?.settings ?? {};
      const next = mergeSettings(factory.fields, change.settings, current);
      const missing = factory.fields.find((f) => f.required && !next[f.key]);
      if (missing) throw new RpcError("bad_request", `${missing.label} is needed`);
      if (existing) {
        const live = await this.liveCards(existing.id);
        const locked = changedLockedFields(factory.fields, current, next);
        if (live > 0 && locked.length > 0) {
          throw new RpcError(
            "conflict",
            `${locked.map((f) => f.label).join(" and ")} can't change while ${title(existing, factory)} has ${openCards(live)}: kill them first.`,
          );
        }
      }
      const plugin = this.build(factory, next);
      try {
        await plugin.check();
      } catch (err) {
        if (err instanceof BankError) throw new RpcError("bad_request", err.message);
        this.log(`checking ${factory.id}: ${err instanceof Error ? err.message : String(err)}`);
        throw new RpcError(
          "unavailable",
          `${factory.name} didn't answer; the server's log has why`,
        );
      }
      const id = existing?.id ?? newBankId(factory.id, name, new Set(banks.map((b) => b.id)));
      const saved: SavedBank = { id, kind: factory.id, name, settings: next };
      const list = await this.saved();
      const at = list.findIndex((b) => b.id === id);
      if (at >= 0) list[at] = saved;
      else list.push(saved);
      await this.deps.store.setSetting(SETTING, list);
      await this.load();
      return this.status();
    });
  }

  /** Forgets a saved bank, unless it has cards that still need it to close. */
  remove(id: string): Promise<BankStatus> {
    return this.serially(async () => {
      const bank = this.bank(await this.banks(), id);
      const factory = this.factory(bank.kind);
      if (bank.source === "env") {
        throw new RpcError(
          "conflict",
          `${title(bank, factory)} is set up from the server's environment: take its variables out of the server's .env to remove it.`,
        );
      }
      const live = await this.liveCards(id);
      if (live > 0) {
        throw new RpcError(
          "conflict",
          `${title(bank, factory)} has ${openCards(live)}, and closing them needs it: kill them first.`,
        );
      }
      await this.deps.store.setSetting(
        SETTING,
        (await this.saved()).filter((b) => b.id !== id),
      );
      await this.load();
      return this.status();
    });
  }

  /**
   * Answers a provider asking about a purchase at `purchasePath(kind)`;
   * null when no bank on that plugin signed it.
   */
  purchase(kind: string, request: HookRequest): Promise<HookResponse | null> {
    const ids = this.loaded.filter((b) => b.kind === kind).map((b) => b.id);
    return this.deps.bank.purchase(ids, request);
  }

  /**
   * How providers reach this server from the internet: the person's own
   * reverse proxy if they've said it's behind one, else Nibblets Connect's
   * tunnel while it's up.
   */
  async publicAddress(): Promise<PublicAddress> {
    const proxy = await this.deps.store.getSetting(
      PROXY_SETTING,
      (v) => ProxyUrl.nullable().parse(v),
      null,
    );
    if (proxy) return { url: proxy, via: "proxy", proxy };
    const tunnel = this.deps.tunnel.current();
    if (tunnel.state === "up" && tunnel.url) {
      return {
        url: tunnel.url.replace(/\/+$/, ""),
        via: tunnel.mode === "quick" ? "quick_tunnel" : "tunnel",
        proxy: null,
      };
    }
    return { url: null, via: null, proxy: null };
  }

  /** Says this server is behind a reverse proxy at `url`, or (null) that it isn't. */
  async setProxy(url: string | null): Promise<BankStatus> {
    if (url) await this.deps.store.setSetting(PROXY_SETTING, url);
    else await this.deps.store.deleteSetting(PROXY_SETTING);
    return this.status();
  }

  private build(factory: BankPluginFactory, settings: BankSettings): BankPlugin {
    let plugin: BankPlugin | null;
    try {
      plugin = factory.fromSettings(settings, this.plugin);
    } catch (err) {
      throw new RpcError("bad_request", err instanceof Error ? err.message : String(err));
    }
    if (!plugin) throw new RpcError("bad_request", `${factory.name} needs more settings`);
    return plugin;
  }

  private factory(kind: string): BankPluginFactory {
    const factory = this.factories.find((f) => f.id === kind);
    if (!factory) throw new RpcError("not_found", `No bank plugin called ${kind}`);
    return factory;
  }

  private bank(banks: readonly ResolvedBank[], id: string): ResolvedBank {
    const bank = banks.find((b) => b.id === id);
    if (!bank) throw new RpcError("not_found", `No bank called ${id}`);
    return bank;
  }

  private async banks(): Promise<ResolvedBank[]> {
    return resolveBanks(this.factories, await this.saved(), this.deps.env);
  }

  private saved(): Promise<SavedBank[]> {
    return this.deps.store.getSetting(SETTING, (v) => Saved.parse(v), []);
  }

  private async liveCards(id: string): Promise<number> {
    return (await this.deps.store.liveCards()).filter((c) => c.provider === id).length;
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Where a plugin's providers ask about purchases. */
export function purchasePath(kind: string): string {
  return `/bank/${kind}/purchases`;
}

/** "Travel (Slash)", or just "Slash". */
function title(bank: { name: string }, factory: BankPluginFactory): string {
  return bank.name ? `${bank.name} (${factory.name})` : factory.name;
}

function openCards(n: number): string {
  return n === 1 ? "a card that isn't closed" : `${n} cards that aren't closed`;
}
