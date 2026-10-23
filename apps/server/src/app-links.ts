import {
  AppLinkError,
  AppLinkRevokedError,
  resolveSettings,
  type AppLinkFactory,
  type AppLinkPlugin,
  type LinkRef,
  type LinkStart,
} from "@nibblets/app-link";
import { infrawrench } from "@nibblets/app-link-infrawrench";
import type { appLinks, nibbletAppGrants } from "@nibblets/db";
import {
  isReservedMcpName,
  RpcError,
  type AppGrant,
  type AppLink,
  type AppLinkAttempt,
  type AppLinkDescription,
  type AppLinkKind,
  type AppLinkOutcome,
  type AppLinks as AppLinksStatus,
  type AppLinkServer,
  type AppLinkSettings,
  type LiveMessage,
} from "@nibblets/protocol";
import { newId } from "./store.ts";

/**
 * Every app link plugin the server knows. Links are made with them in
 * Settings, and kept in the database with their secrets.
 */
export const APP_LINK_PLUGINS: readonly AppLinkFactory[] = [infrawrench];

/** How often links are checked with their apps, and unfinished revokes tried again. */
const SYNC_EVERY_MS = 5 * 60_000;
/** How long a revoke or an unlink the app never takes is tried before it's given up on. */
const GIVE_UP_MS = 24 * 60 * 60_000;
/** The least time between polls, whatever the app says. */
const MIN_INTERVAL_S = 2;

export type AppLinkRow = typeof appLinks.$inferSelect;
export type AppGrantRow = typeof nibbletAppGrants.$inferSelect;

/** The database, as app links use it. */
export interface AppLinkStore {
  appLinks(): Promise<AppLinkRow[]>;
  createAppLink(row: Omit<AppLinkRow, "createdAt" | "updatedAt">): Promise<AppLinkRow>;
  updateAppLink(
    id: string,
    patch: Partial<Pick<AppLinkRow, "account" | "state" | "detail">>,
  ): Promise<void>;
  /** Its grants go with it. */
  deleteAppLink(id: string): Promise<void>;
  appGrants(filter: { nibbletId?: string; linkId?: string }): Promise<AppGrantRow[]>;
  /** Adds the grant, or replaces the nibblet's one on the same link. */
  putAppGrant(row: Omit<AppGrantRow, "createdAt" | "updatedAt">): Promise<void>;
  updateAppGrant(
    nibbletId: string,
    linkId: string,
    patch: Partial<Pick<AppGrantRow, "scopes" | "providers" | "state" | "detail">>,
  ): Promise<void>;
  deleteAppGrant(nibbletId: string, linkId: string): Promise<void>;
  nibbletRow(id: string): Promise<{ id: string; name: string; parentId: string | null }>;
}

export interface AppLinksDeps {
  store: AppLinkStore;
  publish(message: LiveMessage): void;
  /** What the app is told this server is: "Nibblets on PogAir-4". */
  label(): Promise<string>;
  /** Hands a nibblet (and its sub-agents) its app links again, when they've changed. */
  reconfigure(nibbletId: string): Promise<void>;
  factories?: readonly AppLinkFactory[];
  fetch?: typeof globalThis.fetch;
  log?(message: string): void;
}

/** What a nibblet is told about one of its app links. */
export interface AppPrompt {
  /** The name its tools go by. */
  name: string;
  /** The app's: "Infrawrench". */
  title: string;
  account: string;
  scopes: string[];
  providers: string[];
  /** What the plugin has to say about it. */
  prompt: string | null;
}

/** What a nibblet's app links come to: the servers its guard serves, and what it's told. */
export interface AppConnections {
  servers: AppLinkServer[];
  prompts: AppPrompt[];
}

interface Attempt {
  id: string;
  factory: AppLinkFactory;
  plugin: AppLinkPlugin;
  settings: AppLinkSettings;
  start: LinkStart;
  /** Between polls, in seconds; longer after the app says to slow down. */
  interval: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const iso = (d: Date) => d.toISOString();

export function toAppLink(row: AppLinkRow): AppLink {
  return {
    id: row.id,
    plugin: row.plugin,
    name: row.name,
    account: row.account,
    settings: row.settings,
    state: row.state,
    detail: row.detail,
    createdAt: iso(row.createdAt),
  };
}

export function toAppGrant(row: AppGrantRow): AppGrant {
  return {
    nibbletId: row.nibbletId,
    linkId: row.linkId,
    scopes: row.scopes,
    providers: row.providers,
    state: row.state,
    detail: row.detail,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * The name a new link's tools go by: its plugin's id while that's free (so
 * the first link has it), then the id with a number after it.
 */
export function newLinkName(plugin: string, taken: ReadonlySet<string>): string {
  const free = (name: string) => !taken.has(name) && !isReservedMcpName(name);
  if (free(plugin)) return plugin;
  const stem = plugin.slice(0, 36);
  for (let n = 2; ; n++) if (free(`${stem}-${n}`)) return `${stem}-${n}`;
}

/**
 * The server's links to other apps, and each nibblet's grants on them.
 * Linking is a code the person approves in the app, which the server waits
 * on; a grant is a credential of the nibblet's own, which only its guard
 * is ever given. Each plugin knows its own app, so nothing here knows one
 * from another.
 *
 * When an app says a link or a grant was revoked there, it's marked so and
 * no longer handed out. Revoking that the app can't be told of yet (it's
 * down, say) is kept and tried again, for a day.
 */
export class AppLinks {
  private readonly deps: AppLinksDeps;
  private readonly factories: readonly AppLinkFactory[];
  private readonly fetch: typeof globalThis.fetch;
  private readonly log: (message: string) => void;
  private readonly attempts = new Map<string, Attempt>();
  /** One change at a time, so two can't each act on what the other is changing. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AppLinksDeps) {
    this.deps = deps;
    this.factories = deps.factories ?? APP_LINK_PLUGINS;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.log = deps.log ?? ((message) => console.warn(`app links: ${message}`));
  }

  plugins(): AppLinkKind[] {
    return this.factories.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      icon: f.icon,
      fields: [...f.fields],
    }));
  }

  async list(): Promise<AppLinksStatus> {
    return {
      links: (await this.deps.store.appLinks()).map(toAppLink),
      attempts: [...this.attempts.values()].map(toAttempt),
    };
  }

  // Linking

  /** Asks the app for a code, and waits for the person to approve it there. */
  async begin(pluginId: string, input: AppLinkSettings): Promise<AppLinkAttempt> {
    const factory = this.factory(pluginId);
    const settings = this.refusals(() => resolveSettings(factory.fields, input));
    const plugin = this.refusals(() => factory.create(settings, { fetch: this.fetch }));
    const label = await this.deps.label();
    const start = await plugin.begin({ label }).catch((err: unknown) => {
      throw this.failure(factory.id, err);
    });
    const attempt: Attempt = {
      id: newId("lna"),
      factory,
      plugin,
      settings,
      start,
      interval: Math.max(MIN_INTERVAL_S, start.interval),
      timer: null,
    };
    this.attempts.set(attempt.id, attempt);
    this.schedulePoll(attempt);
    this.deps.publish({ type: "app_links_changed" });
    return toAttempt(attempt);
  }

  /** Stops waiting on an attempt. One that's already over is fine. */
  cancel(id: string): void {
    const attempt = this.attempts.get(id);
    if (attempt) this.settle(attempt, "cancelled", null, null);
  }

  private schedulePoll(attempt: Attempt): void {
    attempt.timer = setTimeout(() => void this.poll(attempt), attempt.interval * 1000);
    attempt.timer.unref?.();
  }

  /** One poll of an attempt; schedules the next until it settles. */
  async poll(attempt: Attempt): Promise<void> {
    if (this.attempts.get(attempt.id) !== attempt) return;
    if (attempt.start.expiresAt.getTime() <= Date.now()) {
      this.settle(attempt, "expired", null, null);
      return;
    }
    try {
      const answer = await attempt.plugin.poll(attempt.start);
      if (this.attempts.get(attempt.id) !== attempt) {
        // Cancelled while it was asked; a link it made anyway isn't wanted.
        if (answer.status === "linked") {
          void attempt.plugin.unlink(answer.link).catch(() => undefined);
        }
        return;
      }
      switch (answer.status) {
        case "slow_down":
          attempt.interval += 5;
          this.schedulePoll(attempt);
          return;
        case "pending":
          this.schedulePoll(attempt);
          return;
        case "denied":
        case "expired":
          this.settle(attempt, answer.status, null, null);
          return;
        case "linked": {
          const id = await this.serially(() => this.keep(attempt, answer.link, answer.account));
          this.settle(attempt, "linked", id, null);
          return;
        }
      }
    } catch (err) {
      if (this.attempts.get(attempt.id) !== attempt) return;
      if (err instanceof AppLinkError) {
        this.settle(attempt, "failed", null, err.message);
        return;
      }
      // The app may be briefly away; keep asking until the code expires.
      this.log(`polling ${attempt.factory.id}: ${message(err)}`);
      attempt.interval = Math.min(attempt.interval * 2, 60);
      this.schedulePoll(attempt);
    }
  }

  private async keep(attempt: Attempt, link: LinkRef, account: string): Promise<string> {
    const links = await this.deps.store.appLinks();
    const row = await this.deps.store.createAppLink({
      id: newId("lnk"),
      plugin: attempt.factory.id,
      name: newLinkName(attempt.factory.id, new Set(links.map((l) => l.name))),
      settings: attempt.settings,
      ref: link.ref,
      secret: link.secret,
      account,
      state: "linked",
      detail: null,
    });
    console.log(`app links: linked ${attempt.factory.name} as ${account}`);
    return row.id;
  }

  private settle(
    attempt: Attempt,
    outcome: AppLinkOutcome,
    linkId: string | null,
    detail: string | null,
  ): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    this.attempts.delete(attempt.id);
    this.deps.publish({ type: "app_link_settled", attemptId: attempt.id, outcome, linkId, detail });
    this.deps.publish({ type: "app_links_changed" });
  }

  /**
   * Unlinks: the app revokes the link and every grant it made. If the app
   * can't be told yet, the link stops being handed out now, and the server
   * keeps trying.
   */
  remove(id: string): Promise<void> {
    return this.serially(async () => {
      const link = await this.link(id);
      const grants = await this.deps.store.appGrants({ linkId: id });
      if (!(await this.unlink(link))) {
        await this.deps.store.updateAppLink(id, {
          state: "removing",
          detail: `Couldn't reach ${this.title(link)} to unlink it; trying again`,
        });
      }
      this.deps.publish({ type: "app_links_changed" });
      await this.refresh(grants.filter((g) => g.state === "active").map((g) => g.nibbletId));
    });
  }

  /** Tells the app to unlink, and forgets the link once it has. Whether it has. */
  private async unlink(link: AppLinkRow): Promise<boolean> {
    try {
      await this.plugin(link).unlink(linkRef(link));
    } catch (err) {
      this.log(`unlinking ${link.id}: ${message(err)}`);
      return false;
    }
    await this.deps.store.deleteAppLink(link.id);
    return true;
  }

  /** What a link may grant, as its app says now. */
  async describe(id: string): Promise<AppLinkDescription> {
    const link = await this.link(id);
    this.usable(link);
    const description = await this.onLink(link, (plugin) => plugin.describe(linkRef(link)));
    if (description.account !== link.account) {
      await this.deps.store.updateAppLink(id, { account: description.account });
      this.deps.publish({ type: "app_links_changed" });
    }
    return description;
  }

  // Grants

  /** A nibblet's grants; a sub-agent's are its host's. */
  async grants(nibbletId: string): Promise<AppGrant[]> {
    const host = await this.hostOf(nibbletId);
    return (await this.deps.store.appGrants({ nibbletId: host })).map(toAppGrant);
  }

  /**
   * Gives a nibblet its own credential on a link, or changes what the one
   * it has may do. One the app revoked, or that's still being revoked, is
   * replaced with a new one.
   */
  setGrant(
    nibbletId: string,
    linkId: string,
    scopes: string[],
    providers: string[],
  ): Promise<AppGrant> {
    return this.serially(async () => {
      const nibblet = await this.deps.store.nibbletRow(nibbletId);
      if (nibblet.parentId) {
        throw new RpcError("bad_request", "A sub-agent uses its parent's app links");
      }
      const link = await this.link(linkId);
      this.usable(link);
      const ref = linkRef(link);
      const [existing] = await this.deps.store.appGrants({ nibbletId, linkId });
      if (existing?.state === "active") {
        try {
          const updated = await this.onLink(link, (plugin) =>
            plugin.update(ref, existing, { label: nibblet.name, scopes, providers }),
          );
          await this.deps.store.updateAppGrant(nibbletId, linkId, { ...updated, detail: null });
          return this.finishGrant(nibbletId, linkId);
        } catch (err) {
          // Revoked in the app: saving here asks for it again, so a new one's made.
          if (!(err instanceof AppLinkRevokedError && err.what === "grant")) throw err;
        }
      } else if (existing) {
        // Anything left of it in the app goes first; the app may not have it at all.
        await this.plugin(link)
          .revoke(ref, existing)
          .catch(() => undefined);
      }
      const made = await this.onLink(link, (plugin) =>
        plugin.grant(ref, { externalId: nibbletId, label: nibblet.name, scopes, providers }),
      );
      await this.deps.store.putAppGrant({
        nibbletId,
        linkId,
        ref: made.ref,
        secret: made.secret,
        scopes: made.scopes,
        providers: made.providers,
        state: "active",
        detail: null,
      });
      return this.finishGrant(nibbletId, linkId);
    });
  }

  private async finishGrant(nibbletId: string, linkId: string): Promise<AppGrant> {
    const [row] = await this.deps.store.appGrants({ nibbletId, linkId });
    if (!row) throw new Error("the grant wasn't saved");
    this.deps.publish({ type: "app_grants_changed", nibbletId });
    await this.refresh([nibbletId]);
    return toAppGrant(row);
  }

  /** Takes a nibblet's grant on a link away, revoking it in the app. */
  removeGrant(nibbletId: string, linkId: string): Promise<void> {
    return this.serially(async () => {
      const [grant] = await this.deps.store.appGrants({ nibbletId, linkId });
      if (!grant) return;
      await this.revoke(grant);
      this.deps.publish({ type: "app_grants_changed", nibbletId });
      await this.refresh([nibbletId]);
    });
  }

  /** Revokes every grant of a nibblet that's being deleted. */
  forget(nibbletId: string): Promise<void> {
    return this.serially(async () => {
      for (const grant of await this.deps.store.appGrants({ nibbletId })) {
        await this.revoke(grant);
      }
    });
  }

  /**
   * Revokes a grant in its app and forgets it; if the app can't be told
   * yet, it's kept as `revoking` (and no longer handed out) to try again.
   */
  private async revoke(grant: AppGrantRow): Promise<void> {
    const link = (await this.deps.store.appLinks()).find((l) => l.id === grant.linkId);
    try {
      if (link && link.state === "linked") {
        await this.plugin(link).revoke(linkRef(link), grant);
      }
    } catch (err) {
      // A link the app revoked took its grants with it.
      if (!(err instanceof AppLinkRevokedError)) {
        this.log(`revoking ${grant.nibbletId}'s grant on ${grant.linkId}: ${message(err)}`);
        if (grant.state !== "revoking") {
          await this.deps.store.updateAppGrant(grant.nibbletId, grant.linkId, {
            state: "revoking",
            detail: `Couldn't reach ${link ? this.title(link) : "the app"} to revoke it; trying again`,
          });
        }
        return;
      }
      if (link && err.what === "link") await this.revoked(link, err.message);
    }
    await this.deps.store.deleteAppGrant(grant.nibbletId, grant.linkId);
  }

  // Delivery

  /**
   * What a nibblet's guard serves for its app links, and what it's told:
   * its host's active grants, on links that work.
   */
  async connections(nibbletId: string): Promise<AppConnections> {
    const host = await this.hostOf(nibbletId);
    const grants = await this.deps.store.appGrants({ nibbletId: host });
    const active = grants.filter((g) => g.state === "active");
    if (active.length === 0) return { servers: [], prompts: [] };
    const links = new Map((await this.deps.store.appLinks()).map((l) => [l.id, l]));
    const servers: AppLinkServer[] = [];
    const prompts: AppPrompt[] = [];
    for (const grant of active) {
      const link = links.get(grant.linkId);
      if (!link || link.state !== "linked") continue;
      let connection;
      try {
        connection = this.plugin(link).connection({ ref: grant.ref, secret: grant.secret });
      } catch (err) {
        this.log(`connecting ${host} to ${link.id}: ${message(err)}`);
        continue;
      }
      if (connection.mcp) servers.push({ name: link.name, ...connection.mcp });
      prompts.push({
        name: link.name,
        title: this.title(link),
        account: link.account,
        scopes: grant.scopes,
        providers: grant.providers,
        prompt: connection.prompt ?? null,
      });
    }
    return { servers, prompts };
  }

  // Keeping up with the apps

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const attempt of this.attempts.values()) if (attempt.timer) clearTimeout(attempt.timer);
    this.attempts.clear();
  }

  /**
   * Tries again what the apps couldn't be told (unlinks and revokes), and
   * asks each working link's app what it has revoked there.
   */
  sync(): Promise<void> {
    return this.serially(async () => {
      const now = Date.now();
      for (const link of await this.deps.store.appLinks()) {
        if (link.state === "removing") {
          if (await this.unlink(link)) continue;
          if (now - link.updatedAt.getTime() > GIVE_UP_MS) {
            this.log(`gave up unlinking ${link.id} (${link.account}); revoke it in the app`);
            await this.deps.store.deleteAppLink(link.id);
          }
          continue;
        }
        if (link.state !== "linked") continue;
        await this.inspect(link).catch((err: unknown) =>
          this.log(`checking ${link.id}: ${message(err)}`),
        );
      }
      for (const grant of await this.deps.store.appGrants({})) {
        if (grant.state !== "revoking") continue;
        await this.revoke(grant);
        if (now - grant.updatedAt.getTime() > GIVE_UP_MS) {
          const [left] = await this.deps.store.appGrants({
            nibbletId: grant.nibbletId,
            linkId: grant.linkId,
          });
          if (left?.state === "revoking") {
            this.log(`gave up revoking ${grant.nibbletId}'s grant on ${grant.linkId}`);
            await this.deps.store.deleteAppGrant(grant.nibbletId, grant.linkId);
          }
        }
      }
    });
  }

  private async inspect(link: AppLinkRow): Promise<void> {
    let seen;
    try {
      seen = await this.plugin(link).inspect(linkRef(link));
    } catch (err) {
      if (err instanceof AppLinkRevokedError && err.what === "link") {
        await this.revoked(link, err.message);
        return;
      }
      throw err;
    }
    if (seen.account !== link.account) {
      await this.deps.store.updateAppLink(link.id, { account: seen.account });
      this.deps.publish({ type: "app_links_changed" });
    }
    const revoked = new Set(seen.revoked);
    for (const grant of await this.deps.store.appGrants({ linkId: link.id })) {
      if (grant.state !== "active" || !revoked.has(grant.ref)) continue;
      await this.deps.store.updateAppGrant(grant.nibbletId, grant.linkId, {
        state: "revoked",
        detail: `Revoked in ${this.title(link)}`,
      });
      this.deps.publish({ type: "app_grants_changed", nibbletId: grant.nibbletId });
      await this.refresh([grant.nibbletId]);
    }
  }

  /** The app revoked a link: so are its grants, and nothing on it is handed out. */
  private async revoked(link: AppLinkRow, detail: string): Promise<void> {
    if (link.state === "linked") {
      console.warn(`app links: ${link.id} (${link.account}) was revoked in its app`);
      await this.deps.store.updateAppLink(link.id, { state: "revoked", detail });
      link.state = "revoked";
      this.deps.publish({ type: "app_links_changed" });
    }
    const grants = await this.deps.store.appGrants({ linkId: link.id });
    for (const grant of grants) {
      if (grant.state !== "active") continue;
      await this.deps.store.updateAppGrant(grant.nibbletId, grant.linkId, {
        state: "revoked",
        detail: `Its link was revoked in ${this.title(link)}`,
      });
      this.deps.publish({ type: "app_grants_changed", nibbletId: grant.nibbletId });
    }
    await this.refresh(grants.filter((g) => g.state === "active").map((g) => g.nibbletId));
  }

  // Helpers

  /**
   * Runs a call on a link's app, as an RPC would answer it: what the app
   * refused, it says; a link the app revoked is marked so; anything else is
   * logged, since it may carry credentials.
   */
  private async onLink<T>(
    link: AppLinkRow,
    work: (plugin: AppLinkPlugin) => Promise<T>,
  ): Promise<T> {
    const plugin = this.plugin(link);
    try {
      return await work(plugin);
    } catch (err) {
      if (err instanceof AppLinkRevokedError && err.what === "link") {
        await this.revoked(link, err.message);
        throw new RpcError("conflict", `${err.message}: link it again`);
      }
      if (err instanceof AppLinkRevokedError) throw err;
      throw this.failure(link.plugin, err);
    }
  }

  private failure(pluginId: string, err: unknown): RpcError {
    if (err instanceof RpcError) return err;
    if (err instanceof AppLinkError) return new RpcError("bad_request", err.message);
    const name = this.factories.find((f) => f.id === pluginId)?.name ?? pluginId;
    this.log(`${pluginId}: ${message(err)}`);
    return new RpcError("unavailable", `${name} didn't answer; the server's log has why`);
  }

  private refusals<T>(work: () => T): T {
    try {
      return work();
    } catch (err) {
      if (err instanceof AppLinkError) throw new RpcError("bad_request", err.message);
      throw err;
    }
  }

  private usable(link: AppLinkRow): void {
    if (link.state === "revoked") {
      throw new RpcError(
        "conflict",
        `This link was revoked in ${this.title(link)}: remove it and link again`,
      );
    }
    if (link.state === "removing") throw new RpcError("conflict", "This link is being removed");
  }

  private factory(id: string): AppLinkFactory {
    const factory = this.factories.find((f) => f.id === id);
    if (!factory) throw new RpcError("not_found", `No app link plugin called ${id}`);
    return factory;
  }

  private plugin(link: AppLinkRow): AppLinkPlugin {
    return this.refusals(() =>
      this.factory(link.plugin).create(link.settings, { fetch: this.fetch }),
    );
  }

  private title(link: AppLinkRow): string {
    return this.factories.find((f) => f.id === link.plugin)?.name ?? link.plugin;
  }

  private async link(id: string): Promise<AppLinkRow> {
    const link = (await this.deps.store.appLinks()).find((l) => l.id === id);
    if (!link) throw new RpcError("not_found", `No app link ${id}`);
    return link;
  }

  /** The nibblet whose grants a nibblet uses: itself, or for a sub-agent the top of its tree. */
  private async hostOf(nibbletId: string): Promise<string> {
    let row = await this.deps.store.nibbletRow(nibbletId);
    while (row.parentId) row = await this.deps.store.nibbletRow(row.parentId);
    return row.id;
  }

  private async refresh(nibbletIds: readonly string[]): Promise<void> {
    for (const id of new Set(nibbletIds)) {
      await this.deps
        .reconfigure(id)
        .catch((err: unknown) => this.log(`reconfiguring ${id}: ${message(err)}`));
    }
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function toAttempt(attempt: Attempt): AppLinkAttempt {
  return {
    id: attempt.id,
    plugin: attempt.factory.id,
    userCode: attempt.start.userCode,
    verificationUrl: attempt.start.verificationUrl,
    verificationUrlComplete: attempt.start.verificationUrlComplete,
    expiresAt: iso(attempt.start.expiresAt),
  };
}

function linkRef(link: AppLinkRow): LinkRef {
  return { ref: link.ref, secret: link.secret };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
