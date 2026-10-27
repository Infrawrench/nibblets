import {
  ThirdPartyAbilities,
  ThirdPartyAnswer,
  ThirdPartySend,
  ThirdPartyState,
  ThirdPartyTokenInput,
  type ThirdParty,
  type ThirdPartyActivity,
  type ThirdPartyKind,
  type ThirdPartyList,
} from "@nibblets/protocol";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  pkce,
  registerClient,
  renewGrant,
  StaleClientError,
  ThirdPartyError,
  ThirdPartyRevokedError,
  type ThirdPartyAgent,
  type ThirdPartyDeps,
  type Grant,
  type ThirdPartyFactory,
} from "@nibblets/third-party";
import { notra } from "@nibblets/third-party-notra";
import { revnu } from "@nibblets/third-party-revnu";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { App, ConnectEnv } from "./app.ts";
import { randomId, randomToken, sha256 } from "./secrets.ts";
import { vault, type Vault } from "./vault.ts";

/*
 * Third parties: other companies' agents, connected to a person's account
 * and shown in the sidebar beside their nibblets. Unlike servers, Connect
 * is in the data path here: third parties' APIs are for servers, not
 * browsers (Revnu's sends no CORS headers, so its token can't leak into a
 * page), so the browser asks Connect, which asks the third party with the
 * credential it keeps sealed. Every third party is a plugin
 * (`@nibblets/third-party`); nothing here knows one from another. A
 * credential that runs out (Notra's) is renewed with the refresh token
 * signing in gave, shortly before it does.
 */

/** Every third party Connect offers. Adding one is adding its plugin here. */
export const thirdPartyPlugins: readonly ThirdPartyFactory[] = [revnu, notra];

/** How long a person has to finish signing in on a third party's site. */
const SIGN_IN_TTL_MS = 10 * 60_000;

/** How long the sidebar waits on one third party before saying it isn't answering. */
const ACTIVITY_TIMEOUT_MS = 8_000;

/** How long before a credential runs out it's renewed, so one in use doesn't. */
const RENEW_EARLY_MS = 60_000;

/** How long one request may take to renew a credential before another may take it over. */
const RENEWING_MS = 20_000;

/** How often a request waiting on another's renewal looks for the result. */
const RENEWAL_POLL_MS = 250;

const PartyRow = z.object({
  id: z.string(),
  user_id: z.string(),
  plugin: z.string(),
  ref: z.string(),
  account: z.string(),
  credential: z.string(),
  abilities: z.string(),
  state: ThirdPartyState,
  connected_at: z.string(),
  refresh: z.string().nullable(),
  client_id: z.string().nullable(),
  expires_at: z.string().nullable(),
  renewing_until: z.string().nullable(),
});
type PartyRow = z.infer<typeof PartyRow>;

const SignInRow = z.object({
  plugin: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  verifier: z.string(),
  code: z.string(),
  expires_at: z.string(),
});

export interface ThirdPartyOptions {
  plugins?: readonly ThirdPartyFactory[];
  /** How plugins reach third parties; tests stand in for them. */
  fetch?: typeof globalThis.fetch;
}

function kind(factory: ThirdPartyFactory): ThirdPartyKind {
  return {
    id: factory.id,
    name: factory.name,
    description: factory.description,
    icon: factory.icon,
    signIn: factory.signIn !== null,
    token: factory.token,
  };
}

function abilitiesOf(row: PartyRow): ThirdPartyAbilities {
  const parsed = ThirdPartyAbilities.safeParse(JSON.parse(row.abilities));
  return parsed.success
    ? parsed.data
    : { chat: false, status: false, requests: false, decide: false };
}

/** What an error may tell the person: a plugin's own words, or that it isn't answering. */
function sayable(err: unknown, name: string): string {
  if (err instanceof ThirdPartyError) return err.message;
  return `${name} isn't answering. Try again in a little while.`;
}

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * The routes, under `/v1/third-parties`. `requireUser` is Connect's own;
 * `publicUrl` is the address the third party sends the person back to.
 */
export function thirdPartyRoutes(
  requireUser: MiddlewareHandler<App>,
  publicUrl: (c: Context<App>) => string,
  options: ThirdPartyOptions = {},
) {
  const plugins = options.plugins ?? thirdPartyPlugins;
  const deps: ThirdPartyDeps = { fetch: options.fetch ?? ((input, init) => fetch(input, init)) };
  /** Plugins' deps for one request, which can keep work going after it's answered. */
  const depsFor = (c: Context<App>): ThirdPartyDeps => {
    try {
      const ctx = c.executionCtx;
      return { ...deps, waitUntil: (work) => ctx.waitUntil(work) };
    } catch {
      // Hono throws when there's no execution context, as in tests.
      return deps;
    }
  };
  const factory = (id: string) => plugins.find((p) => p.id === id) ?? null;
  const routes = new Hono<App>();

  const redirectUri = (c: Context<App>) => `${publicUrl(c)}/v1/third-parties/callback`;

  const sealer = (env: ConnectEnv): Vault => {
    const v = vault(env.THIRD_PARTY_KEY);
    if (!v) throw new ThirdPartyError("Third parties aren't set up on this Connect");
    return v;
  };

  const toParty = (
    row: PartyRow,
    activity: ThirdPartyActivity | null,
    problem: string | null,
  ): ThirdParty => ({
    id: row.id,
    plugin: row.plugin,
    account: row.account,
    state: row.state,
    abilities: abilitiesOf(row),
    connectedAt: row.connected_at,
    activity,
    problem,
  });

  /**
   * Connects a credential to a person's account: the plugin says who it
   * is, and connecting the same account again replaces the old credential.
   * `clientId` is the client signing in registered, to renew it with.
   */
  async function connect(
    env: ConnectEnv,
    userId: string,
    plugin: ThirdPartyFactory,
    grant: Grant,
    clientId: string | null,
  ): Promise<string> {
    const seal = sealer(env);
    const who = await plugin.identify(grant.access, deps);
    const existing = await env.DB.prepare(
      "SELECT id FROM third_parties WHERE user_id = ? AND plugin = ? AND ref = ?",
    )
      .bind(userId, plugin.id, who.ref)
      .first<{ id: string }>();
    const id = existing?.id ?? randomId("tp");
    const sealed = await seal.seal(grant.access, id);
    const refresh =
      grant.refresh && clientId ? await seal.seal(grant.refresh, `${id}:refresh`) : null;
    const expiresAt = grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null;
    const abilities = JSON.stringify(who.abilities);
    if (existing) {
      await env.DB.prepare(
        "UPDATE third_parties SET account = ?, credential = ?, abilities = ?, state = 'live', refresh = ?, client_id = ?, expires_at = ?, renewing_until = NULL WHERE id = ?",
      )
        .bind(who.account, sealed, abilities, refresh, refresh ? clientId : null, expiresAt, id)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO third_parties (id, user_id, plugin, ref, account, credential, abilities, connected_at, refresh, client_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          id,
          userId,
          plugin.id,
          who.ref,
          who.account,
          sealed,
          abilities,
          new Date().toISOString(),
          refresh,
          refresh ? clientId : null,
          expiresAt,
        )
        .run();
    }
    return id;
  }

  /**
   * The credential to use now: the one kept, or, when that's about to run
   * out and there's a refresh token, a renewed one, kept in its place. A
   * refresh token may only be used once, so one request at a time claims
   * renewing it; the rest use the old credential while it still works, or
   * wait for the new one, and take the claim over if it lapses unfinished.
   */
  async function credentialOf(
    env: ConnectEnv,
    row: PartyRow,
    requestDeps: ThirdPartyDeps,
  ): Promise<string> {
    const seal = sealer(env);
    const plugin = factory(row.plugin);
    const signIn = plugin?.signIn;
    const refresh = row.refresh;
    const clientId = row.client_id;
    const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
    if (
      !plugin ||
      !signIn ||
      !refresh ||
      !clientId ||
      expiresAt === null ||
      expiresAt - RENEW_EARLY_MS > Date.now()
    ) {
      return seal.open(row.credential, row.id);
    }

    const renew = async (): Promise<string> => {
      let grant: Grant;
      try {
        grant = await renewGrant(
          await discover(signIn.issuer, deps),
          {
            clientId,
            refresh: await seal.open(refresh, `${row.id}:refresh`),
            resource: signIn.resource,
          },
          deps,
        );
      } catch (err) {
        await env.DB.prepare("UPDATE third_parties SET renewing_until = NULL WHERE id = ?")
          .bind(row.id)
          .run();
        throw err;
      }
      await env.DB.prepare(
        "UPDATE third_parties SET credential = ?, refresh = ?, expires_at = ?, renewing_until = NULL WHERE id = ?",
      )
        .bind(
          await seal.seal(grant.access, row.id),
          grant.refresh ? await seal.seal(grant.refresh, `${row.id}:refresh`) : null,
          grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
          row.id,
        )
        .run();
      return grant.access;
    };

    // A claim that lapses is taken over, so this waits out one claim and then renews itself.
    const giveUpAt = Date.now() + 2 * RENEWING_MS;
    for (;;) {
      const now = Date.now();
      const claimed = await env.DB.prepare(
        "UPDATE third_parties SET renewing_until = ? WHERE id = ? AND credential = ? AND (renewing_until IS NULL OR renewing_until < ?)",
      )
        .bind(
          new Date(now + RENEWING_MS).toISOString(),
          row.id,
          row.credential,
          new Date(now).toISOString(),
        )
        .run();
      if (claimed.meta.changes > 0) {
        const renewal = renew();
        // Seen through even if the person stops waiting (the app cancels requests freely): the
        // third party has spent the old refresh token by then, so the new one must be kept.
        requestDeps.waitUntil?.(
          renewal.then(
            () => undefined,
            () => undefined,
          ),
        );
        return renewal;
      }
      if (expiresAt > now) return seal.open(row.credential, row.id);
      // Another request is renewing it, or just has.
      const latest = await env.DB.prepare("SELECT credential FROM third_parties WHERE id = ?")
        .bind(row.id)
        .first<{ credential: string }>();
      if (latest && latest.credential !== row.credential) {
        return seal.open(latest.credential, row.id);
      }
      if (now >= giveUpAt) {
        throw new ThirdPartyError(`${plugin.name} is taking a while to sign in again. Try again.`);
      }
      await new Promise((resolve) => setTimeout(resolve, RENEWAL_POLL_MS));
    }
  }

  /** The plugin for one of the person's third parties, with its credential unsealed. */
  async function open(c: Context<App>, row: PartyRow): Promise<ThirdPartyAgent> {
    const plugin = factory(row.plugin);
    if (!plugin) throw new ThirdPartyError("Connect doesn't offer this third party any more");
    const requestDeps = depsFor(c);
    return plugin.create(
      await credentialOf(c.env, row, requestDeps),
      abilitiesOf(row),
      requestDeps,
    );
  }

  const ownParty = async (c: Context<App>): Promise<PartyRow | null> => {
    const row = await c.env.DB.prepare("SELECT * FROM third_parties WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id") ?? "", c.get("user").id)
      .first();
    return row ? PartyRow.parse(row) : null;
  };

  /**
   * Runs `work` with one of the person's third parties: a revoked one is
   * marked so, a plugin's refusal is shown as it says it, and anything else
   * is logged and shown as it not answering.
   */
  async function using(
    c: Context<App>,
    work: (agent: ThirdPartyAgent, row: PartyRow) => Promise<Response>,
  ): Promise<Response> {
    const row = await ownParty(c);
    if (!row) return c.json({ error: "No such third party" }, 404);
    const name = factory(row.plugin)?.name ?? row.plugin;
    if (row.state === "revoked") {
      return c.json({ error: `${name} no longer takes this connection. Connect it again.` }, 409);
    }
    try {
      return await work(await open(c, row), row);
    } catch (err) {
      if (err instanceof ThirdPartyRevokedError) {
        await c.env.DB.prepare("UPDATE third_parties SET state = 'revoked' WHERE id = ?")
          .bind(row.id)
          .run();
        return c.json({ error: err.message, revoked: true }, 409);
      }
      if (!(err instanceof ThirdPartyError)) {
        console.error(
          JSON.stringify({
            message: "third party failed",
            plugin: row.plugin,
            path: c.req.path,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return c.json({ error: sayable(err, name) }, 502);
      }
      return c.json({ error: err.message }, 422);
    }
  }

  /** Back to the UI after signing in elsewhere, saying what went wrong if something did. */
  const backToSettings = (c: Context<App>, error: string) =>
    c.redirect(`/settings?${new URLSearchParams({ "third-party-error": error })}`, 302);

  routes.get("/", requireUser, async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM third_parties WHERE user_id = ? ORDER BY connected_at",
    )
      .bind(c.get("user").id)
      .all();
    const rows = results.map((r) => PartyRow.parse(r));
    const parties = await Promise.all(
      rows.map(async (row): Promise<ThirdParty> => {
        if (row.state === "revoked") return toParty(row, null, null);
        const name = factory(row.plugin)?.name ?? row.plugin;
        try {
          const agent = await open(c, row);
          return toParty(row, await within(ACTIVITY_TIMEOUT_MS, agent.activity()), null);
        } catch (err) {
          if (err instanceof ThirdPartyRevokedError) {
            await c.env.DB.prepare("UPDATE third_parties SET state = 'revoked' WHERE id = ?")
              .bind(row.id)
              .run();
            return toParty({ ...row, state: "revoked" }, null, null);
          }
          if (!(err instanceof ThirdPartyError)) {
            console.warn(
              JSON.stringify({
                message: "third party activity failed",
                plugin: row.plugin,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
          return toParty(row, null, sayable(err, name));
        }
      }),
    );
    const list: ThirdPartyList = {
      enabled: vault(c.env.THIRD_PARTY_KEY) !== null,
      kinds: plugins.map(kind),
      parties,
    };
    return c.json(list);
  });

  /** Starts signing in on the third party's site; the UI opens the address it returns. */
  routes.post("/kinds/:plugin/sign-in", requireUser, async (c) => {
    const plugin = factory(c.req.param("plugin"));
    if (!plugin?.signIn) return c.json({ error: "No such third party" }, 404);
    try {
      sealer(c.env);
      const server = await discover(plugin.signIn.issuer, deps);
      const redirect = redirectUri(c);
      let clientId = (
        await c.env.DB.prepare(
          "SELECT client_id FROM third_party_clients WHERE plugin = ? AND redirect_uri = ?",
        )
          .bind(plugin.id, redirect)
          .first<{ client_id: string }>()
      )?.client_id;
      if (!clientId) {
        clientId = await registerClient(
          server,
          { name: "Nibblets", uri: publicUrl(c), redirectUri: redirect },
          plugin.signIn.scopes,
          deps,
        );
        await c.env.DB.prepare(
          "INSERT INTO third_party_clients (plugin, redirect_uri, client_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET client_id = excluded.client_id",
        )
          .bind(plugin.id, redirect, clientId, new Date().toISOString())
          .run();
      }
      const state = randomToken();
      const { verifier, challenge } = await pkce();
      await c.env.DB.prepare(
        "INSERT INTO third_party_sign_ins (state_hash, user_id, plugin, client_id, redirect_uri, verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          await sha256(state),
          c.get("user").id,
          plugin.id,
          clientId,
          redirect,
          verifier,
          new Date(Date.now() + SIGN_IN_TTL_MS).toISOString(),
        )
        .run();
      return c.json({
        url: authorizeUrl(server, {
          clientId,
          redirectUri: redirect,
          state,
          challenge,
          scopes: plugin.signIn.scopes,
          resource: plugin.signIn.resource,
        }),
      });
    } catch (err) {
      if (!(err instanceof ThirdPartyError)) {
        console.error(
          JSON.stringify({
            message: "third party sign-in failed to start",
            plugin: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return c.json(
        { error: sayable(err, plugin.name) },
        err instanceof ThirdPartyError ? 422 : 502,
      );
    }
  });

  /**
   * Where the third party sends the person back. It's a plain page load,
   * not signed in with Clerk, so it only keeps the code and hands the state
   * to the UI, where the person who started signing in finishes it signed
   * in. Otherwise someone could start signing in on their own account, send
   * the link to someone else, and get their access when they approved it.
   */
  routes.get("/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const hash = state ? await sha256(state) : "";
    const row = hash
      ? await c.env.DB.prepare(
          "SELECT plugin, expires_at FROM third_party_sign_ins WHERE state_hash = ? AND code IS NULL",
        )
          .bind(hash)
          .first<{ plugin: string; expires_at: string }>()
      : null;
    if (!row || row.expires_at < new Date().toISOString()) {
      return backToSettings(c, "That sign-in has expired or was already used. Try again.");
    }
    const name = factory(row.plugin)?.name ?? row.plugin;
    const denied = c.req.query("error");
    const code = c.req.query("code");
    if (denied || !code) {
      await c.env.DB.prepare("DELETE FROM third_party_sign_ins WHERE state_hash = ?")
        .bind(hash)
        .run();
      return backToSettings(
        c,
        !denied
          ? `${name} didn't send a code back.`
          : denied === "access_denied"
            ? `${name} wasn't allowed.`
            : `${name} said: ${c.req.query("error_description") ?? denied}`,
      );
    }
    await c.env.DB.prepare("UPDATE third_party_sign_ins SET code = ? WHERE state_hash = ?")
      .bind(code, hash)
      .run();
    return c.redirect(`/settings?${new URLSearchParams({ "third-party-finish": state })}`, 302);
  });

  /**
   * Finishes signing in, from the UI, signed in as whoever started it:
   * swaps the code for the token and connects it. Returns its id.
   */
  routes.post("/finish", requireUser, async (c) => {
    const body = z
      .object({ state: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send { state }" }, 400);
    const row = await c.env.DB.prepare(
      "DELETE FROM third_party_sign_ins WHERE state_hash = ? AND user_id = ? AND code IS NOT NULL RETURNING plugin, client_id, redirect_uri, verifier, code, expires_at",
    )
      .bind(await sha256(body.data.state), c.get("user").id)
      .first();
    const signIn = row ? SignInRow.parse(row) : null;
    if (!signIn || signIn.expires_at < new Date().toISOString()) {
      return c.json(
        { error: "That sign-in has expired, was already used, or was started by someone else." },
        400,
      );
    }
    const plugin = factory(signIn.plugin);
    if (!plugin?.signIn)
      return c.json({ error: "Connect doesn't offer that third party now." }, 404);
    try {
      const server = await discover(plugin.signIn.issuer, deps);
      const grant = await exchangeCode(
        server,
        {
          clientId: signIn.client_id,
          redirectUri: signIn.redirect_uri,
          code: signIn.code,
          verifier: signIn.verifier,
          resource: plugin.signIn.resource,
        },
        deps,
      );
      return c.json({
        id: await connect(c.env, c.get("user").id, plugin, grant, signIn.client_id),
      });
    } catch (err) {
      if (err instanceof StaleClientError) {
        await c.env.DB.prepare(
          "DELETE FROM third_party_clients WHERE plugin = ? AND redirect_uri = ?",
        )
          .bind(plugin.id, signIn.redirect_uri)
          .run();
      } else if (!(err instanceof ThirdPartyError)) {
        console.error(
          JSON.stringify({
            message: "third party sign-in failed",
            plugin: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return c.json(
        { error: sayable(err, plugin.name) },
        err instanceof ThirdPartyError ? 422 : 502,
      );
    }
  });

  /** Connects with a token the person made in the third party's own settings. */
  routes.post("/kinds/:plugin/token", requireUser, async (c) => {
    const plugin = factory(c.req.param("plugin"));
    if (!plugin?.token) return c.json({ error: "No such third party" }, 404);
    const body = ThirdPartyTokenInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send { token }" }, 400);
    try {
      const grant = { access: body.data.token, refresh: null, expiresAt: null };
      const id = await connect(c.env, c.get("user").id, plugin, grant, null);
      return c.json({ id });
    } catch (err) {
      if (!(err instanceof ThirdPartyError)) {
        console.error(
          JSON.stringify({
            message: "third party token failed",
            plugin: plugin.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      // A token it doesn't know is just a wrong token here, not a revoked connection.
      return c.json(
        { error: sayable(err, plugin.name) },
        err instanceof ThirdPartyError ? 422 : 502,
      );
    }
  });

  /**
   * Forgets a third party. Its credential stays live in the third party,
   * which has no way to be told: the UI says where to revoke it.
   */
  routes.delete("/:id", requireUser, async (c) => {
    const row = await ownParty(c);
    if (!row) return c.json({ error: "No such third party" }, 404);
    await c.env.DB.prepare("DELETE FROM third_parties WHERE id = ?").bind(row.id).run();
    return c.json({ ok: true });
  });

  routes.get("/:id/thread", requireUser, (c) =>
    using(c, async (agent) => c.json({ messages: await agent.thread() })),
  );

  routes.post("/:id/messages", requireUser, async (c) => {
    const body = ThirdPartySend.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send { text, clientId }" }, 400);
    return using(c, async (agent) => {
      await agent.send(body.data.text, body.data.clientId);
      return c.json({ ok: true });
    });
  });

  routes.get("/:id/requests", requireUser, (c) =>
    using(c, async (agent) => c.json({ requests: await agent.requests() })),
  );

  routes.post("/:id/requests/:request/actions/:action", requireUser, async (c) => {
    const body = ThirdPartyAnswer.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Send { text?, option? }" }, 400);
    return using(c, async (agent) => {
      await agent.act(c.req.param("request"), c.req.param("action"), body.data);
      return c.json({ ok: true });
    });
  });

  return routes;
}

/** Forgets sign-ins nobody finished. */
export async function sweepThirdPartySignIns(env: ConnectEnv, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM third_party_sign_ins WHERE expires_at < ?")
    .bind(new Date(now).toISOString())
    .run();
}
