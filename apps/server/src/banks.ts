import {
  BankError,
  changedLockedFields,
  loadBankPlugins,
  maskSettings,
  mergeSettings,
  resolveSettings,
  type BankDeps,
  type BankPlugin,
  type BankPluginFactory,
  type BankSettingValues,
} from "@nibblet/bank";
import { bitcoin } from "@nibblet/bank-bitcoin";
import { ethereum } from "@nibblet/bank-ethereum";
import { slash } from "@nibblet/bank-slash";
import {
  BankProviderId,
  BankSettings,
  RpcError,
  type BankKind,
  type BankStatus,
} from "@nibblet/protocol";
import { z } from "zod";
import type { Bank } from "./bank.ts";
import type { CardRow, Store } from "./store.ts";

/**
 * Every bank plugin the server knows. Each is set up in Settings, which
 * keeps its settings in the database, or else from the server's environment
 * (variables named like its fields; see `docker/compose.yaml`), and stays
 * off otherwise.
 */
export const BANK_PLUGINS: readonly BankPluginFactory[] = [slash, bitcoin, ethereum];

const SETTING = "banks";
const Saved = z.record(BankProviderId, BankSettings);
type Saved = z.infer<typeof Saved>;

export interface BanksDeps {
  store: Pick<Store, "getSetting" | "setSetting"> & {
    liveCards(): Promise<readonly Pick<CardRow, "provider">[]>;
  };
  bank: Pick<Bank, "status" | "use">;
  env: BankSettingValues;
  factories?: readonly BankPluginFactory[];
  plugin?: BankDeps;
  log?(message: string): void;
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

  constructor(deps: BanksDeps) {
    this.deps = deps;
    this.factories = deps.factories ?? BANK_PLUGINS;
    this.log = deps.log ?? ((message) => console.warn(`bank: ${message}`));
    this.plugin = deps.plugin ?? { fetch: globalThis.fetch, log: this.log };
  }

  /** Loads every bank as it's set up now into the `Bank`. */
  async load(): Promise<void> {
    const saved = await this.saved();
    const settings = new Map(
      this.factories.map((f) => [f.id, resolveSettings(f, saved[f.id], this.deps.env).settings]),
    );
    const { plugins, errors } = loadBankPlugins(this.factories, settings, this.plugin);
    for (const plugin of plugins.values()) console.log(`bank: ${plugin.label} is set up`);
    for (const [id, problem] of errors) this.log(`${id} isn't set up: ${problem}`);
    this.deps.bank.use(plugins, errors);
  }

  async status(): Promise<BankStatus> {
    const [health, kinds] = await Promise.all([this.deps.bank.status(), this.kinds()]);
    return { ...health, kinds };
  }

  /** Checks the settings with the provider, saves them, and loads the bank with them. */
  configure(id: string, input: BankSettings): Promise<BankStatus> {
    return this.serially(async () => {
      const factory = this.factory(id);
      const saved = await this.saved();
      const current = resolveSettings(factory, saved[id], this.deps.env).settings;
      const next = mergeSettings(factory.fields, input, current);
      const missing = factory.fields.find((f) => f.required && !next[f.key]);
      if (missing) throw new RpcError("bad_request", `${missing.label} is needed`);
      const live = await this.liveCards(id);
      const locked = changedLockedFields(factory.fields, current, next);
      if (live > 0 && locked.length > 0) {
        throw new RpcError(
          "conflict",
          `${locked.map((f) => f.label).join(" and ")} can't change while ${factory.name} has ${openCards(live)}: kill them first.`,
        );
      }
      const plugin = this.build(factory, next);
      try {
        await plugin.check();
      } catch (err) {
        if (err instanceof BankError) throw new RpcError("bad_request", err.message);
        this.log(`checking ${id}: ${err instanceof Error ? err.message : String(err)}`);
        throw new RpcError(
          "unavailable",
          `${factory.name} didn't answer; the server's log has why`,
        );
      }
      await this.deps.store.setSetting(SETTING, { ...saved, [id]: next });
      await this.load();
      return this.status();
    });
  }

  /** Forgets a bank's saved settings, unless it has cards that still need it to close. */
  remove(id: string): Promise<BankStatus> {
    return this.serially(async () => {
      const factory = this.factory(id);
      const live = await this.liveCards(id);
      if (live > 0) {
        throw new RpcError(
          "conflict",
          `${factory.name} has ${openCards(live)}, and closing them needs it: kill them first.`,
        );
      }
      const saved = await this.saved();
      delete saved[id];
      await this.deps.store.setSetting(SETTING, saved);
      await this.load();
      return this.status();
    });
  }

  private async kinds(): Promise<BankKind[]> {
    const [saved, live] = await Promise.all([this.saved(), this.deps.store.liveCards()]);
    return this.factories.map((f) => {
      const { source, settings } = resolveSettings(f, saved[f.id], this.deps.env);
      return {
        id: f.id,
        name: f.name,
        about: f.about,
        instrument: f.instrument,
        fields: [...f.fields],
        source,
        settings: maskSettings(f.fields, settings),
        liveCards: live.filter((c) => c.provider === f.id).length,
      };
    });
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

  private factory(id: string): BankPluginFactory {
    const factory = this.factories.find((f) => f.id === id);
    if (!factory) throw new RpcError("not_found", `No bank called ${id}`);
    return factory;
  }

  private saved(): Promise<Saved> {
    return this.deps.store.getSetting(SETTING, (v) => Saved.parse(v), {});
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

function openCards(n: number): string {
  return n === 1 ? "a card that isn't closed" : `${n} cards that aren't closed`;
}
