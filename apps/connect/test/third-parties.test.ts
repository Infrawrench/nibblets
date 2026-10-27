import { ThirdPartyList, ThirdPartyMessage, ThirdPartyRequest } from "@nibblets/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp, type ConnectEnv } from "../src/app.ts";
import { sweepThirdPartySignIns } from "../src/third-parties.ts";
import { migratedDb, privateKey } from "./d1.ts";

/*
 * Third parties end to end against a real D1 database, with the real Revnu
 * plugin talking to a Revnu that keeps its state in memory: signing in on
 * its site (registering, PKCE, the callback), the sidebar's list, talking,
 * answering cards, revocation, and forgetting one.
 */

const LOCAL = "http://localhost:8787";
const REVNU = "https://revnu.com";

/** A Revnu with an OAuth server like its MCP server's, and enough of its API. */
function fakeRevnu() {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { challenge: string; client: string; redirect: string }>();
  const tokens = new Map<string, { account: string; scopes: string[] }>();
  /** Refresh tokens, each good once, when it's set to give tokens that run out. */
  const refreshes = new Set<string>();
  let expiring = false;
  let renewals = 0;
  const sent: { token: string; text: string; clientRequestId: string }[] = [];
  const answered: string[] = [];
  let pending = 2;
  let lastAuthorize: URL | null = null;

  const json = (body: object, status = 200) => Response.json(body, { status });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== REVNU) throw new Error(`unexpected request to ${url.origin}`);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /.well-known/oauth-authorization-server":
        return json({
          issuer: REVNU,
          authorization_endpoint: `${REVNU}/api/mcp/oauth/authorize`,
          token_endpoint: `${REVNU}/api/mcp/oauth/token`,
          registration_endpoint: `${REVNU}/api/mcp/oauth/register`,
          code_challenge_methods_supported: ["S256"],
        });
      case "POST /api/mcp/oauth/register": {
        const body = z
          .object({ redirect_uris: z.array(z.string()), token_endpoint_auth_method: z.string() })
          .parse(await request.json());
        const id = `client_${clients.size + 1}`;
        clients.set(id, body.redirect_uris);
        return json({ client_id: id }, 201);
      }
      case "POST /api/mcp/oauth/token": {
        const form = new URLSearchParams(await request.text());
        const issue = () => {
          const token = `rvp_${tokens.size + 1}`;
          tokens.set(token, {
            account: "acc_1",
            scopes: ["agent:message", "results:read", "review:read", "review:write"],
          });
          if (!expiring) return json({ access_token: token, token_type: "Bearer" });
          const refresh = `rf_${tokens.size}_${Math.random()}`;
          refreshes.add(refresh);
          // Inside the minute Connect renews ahead, so the next use renews it.
          return json({
            access_token: token,
            token_type: "Bearer",
            refresh_token: refresh,
            expires_in: 30,
          });
        };
        if (form.get("grant_type") === "refresh_token") {
          if (!refreshes.delete(form.get("refresh_token") ?? "")) {
            return json({ error: "invalid_grant" }, 400);
          }
          renewals += 1;
          return issue();
        }
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!clients.has(form.get("client_id") ?? ""))
          return json({ error: "invalid_client" }, 401);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(form.get("code_verifier") ?? ""),
        );
        if (
          !code ||
          code.client !== form.get("client_id") ||
          code.redirect !== form.get("redirect_uri") ||
          code.challenge !== Buffer.from(digest).toString("base64url")
        ) {
          return json({ error: "invalid_grant", error_description: "That code won't do" }, 400);
        }
        return issue();
      }
    }
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const holder = tokens.get(token);
    if (!holder) return json({ error: "unauthorized" }, 401);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /api/v1/me":
        return json({
          me: {
            scopes: holder.scopes,
            account: { id: holder.account, name: "Acme" },
            inSetup: false,
          },
        });
      case "GET /api/v1/agent/status":
        return json({ status: { running: sent.length > 0 } });
      case "GET /api/v1/agent/thread":
        return json({
          items: sent
            .filter((m) => m.token === token)
            .map((m, i) => ({
              role: "user",
              requestId: `r${i}`,
              text: m.text,
              at: 1_789_800_000_000 + i,
            }))
            .reverse(),
        });
      case "POST /api/v1/agent/messages": {
        const body = z
          .object({ text: z.string(), clientRequestId: z.string() })
          .parse(await request.json());
        if (!sent.some((m) => m.clientRequestId === body.clientRequestId))
          sent.push({ token, ...body });
        return json({ requestId: "r", deduplicated: false }, 202);
      }
      case "GET /api/v1/review":
        return json({
          items: Array.from({ length: pending }, (_, i) => ({
            id: `k${i}`,
            kind: "approval",
            sourceType: "blog_draft",
            title: `Post ${i}`,
            prompt: `Post ${i}`,
            summary: null,
            detail: null,
            priority: "normal",
            options: null,
            textInput: null,
            budgetChange: null,
            payload: null,
            actions: ["approve", "dismiss"],
            primaryLabel: "Approve & Publish",
            autoResolveAt: null,
            createdAt: 1_789_800_000_000,
          })),
        });
      case "POST /api/v1/review/k0/answer":
        answered.push("k0");
        pending -= 1;
        return json({ ok: true, kind: "approval" });
    }
    return json({ error: "not found" }, 404);
  };

  return {
    fetch,
    sent,
    answered,
    clients,
    /** The person on Revnu's page: allows it, and Revnu sends them back with a code. */
    approve(authorize: string): string {
      const url = new URL(authorize);
      lastAuthorize = url;
      const code = `code_${codes.size + 1}_${Math.random()}`;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        client: url.searchParams.get("client_id") ?? "",
        redirect: url.searchParams.get("redirect_uri") ?? "",
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return back.href;
    },
    lastAuthorize: () => lastAuthorize,
    forgetClients: () => clients.clear(),
    /** Gives tokens that run out, with refresh tokens, from now on. */
    expire: () => {
      expiring = true;
    },
    renewals: () => renewals,
    forgetRefreshes: () => refreshes.clear(),
    revokeAll: () => tokens.clear(),
  };
}

let revnu = fakeRevnu();
let env: ConnectEnv;
let dispose: () => Promise<void>;
const app = createApp({
  thirdParties: { fetch: (input, init) => revnu.fetch(input, init) },
});

beforeAll(async () => {
  const d1 = await migratedDb("nibblets-connect-third-parties");
  dispose = d1.dispose;
  env = {
    DB: d1.db,
    PUBLIC_URL: "",
    CLERK_SECRET_KEY: "",
    CLERK_PUBLISHABLE_KEY: "pk_test_x",
    JWT_PRIVATE_KEY: await privateKey(),
    DEV_AUTH_USER: "astrid",
    CF_API_TOKEN: "",
    CF_ACCOUNT_ID: "",
    CF_ZONE_ID: "",
    CF_ZONE_NAME: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_SUBJECT: "",
    THIRD_PARTY_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  };
});

afterAll(() => dispose());

beforeEach(async () => {
  revnu = fakeRevnu();
  await env.DB.prepare("DELETE FROM third_parties").run();
  await env.DB.prepare("DELETE FROM third_party_clients").run();
});

const call = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`${LOCAL}${path}`, init), env);

const list = async () => ThirdPartyList.parse(await (await call("/v1/third-parties")).json());

/** Starts signing in, as the Settings button does; returns Revnu's page. */
async function startSignIn(): Promise<string> {
  const res = await call("/v1/third-parties/kinds/revnu/sign-in", { method: "POST" });
  expect(res.status).toBe(200);
  return z.object({ url: z.string() }).parse(await res.json()).url;
}

/** Revnu sends the person back: Connect keeps the code and hands the UI the state to finish with. */
async function comeBack(back: string): Promise<URL> {
  const url = new URL(back);
  const res = await call(url.pathname + url.search);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "", LOCAL);
}

/** The UI, signed in, finishing what the callback handed it. */
const finish = (state: string) =>
  call("/v1/third-parties/finish", { method: "POST", body: JSON.stringify({ state }) });

/**
 * The whole sign-in: Connect's button, Revnu's page, back, and the UI
 * finishing it. Returns the page it goes to, or the error it shows.
 */
async function signIn(): Promise<string> {
  const landed = await comeBack(revnu.approve(await startSignIn()));
  const state = landed.searchParams.get("third-party-finish");
  if (!state) return `error: ${landed.searchParams.get("third-party-error")}`;
  const res = await finish(state);
  const body = z
    .object({ id: z.string() })
    .or(z.object({ error: z.string() }))
    .parse(await res.json());
  return "id" in body ? `/t/${body.id}` : `error: ${body.error}`;
}

describe("third parties", () => {
  it("offers its plugins, with none connected yet", async () => {
    const listed = await list();
    expect(listed.enabled).toBe(true);
    expect(listed.kinds.map((k) => [k.id, k.signIn, k.token?.placeholder])).toEqual([
      ["revnu", true, "rvp_…"],
      ["notra", true, "ntra_…"],
    ]);
    expect(listed.kinds[0]?.icon).toMatch(/^data:image\/png;base64,/);
    expect(listed.parties).toEqual([]);
  });

  it("signs in on Revnu's site and lands on the new third party", async () => {
    const authorize = new URL(await startSignIn());
    expect(authorize.origin + authorize.pathname).toBe(`${REVNU}/api/mcp/oauth/authorize`);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${LOCAL}/v1/third-parties/callback`);
    expect(authorize.searchParams.get("scope")).toBe(
      "agent:message results:read review:read review:write",
    );
    expect(authorize.searchParams.get("resource")).toBe(`${REVNU}/api/mcp`);

    const landed = await comeBack(revnu.approve(authorize.href));
    // Nothing's connected until the person who started it finishes it, signed in.
    expect(landed.pathname).toBe("/settings");
    const state = landed.searchParams.get("third-party-finish") ?? "";
    expect(state).toBe(authorize.searchParams.get("state"));
    expect((await list()).parties).toEqual([]);
    const finished = z.object({ id: z.string() }).parse(await (await finish(state)).json());
    const [party] = (await list()).parties;
    expect(finished.id).toBe(party?.id);
    expect(party).toMatchObject({
      plugin: "revnu",
      account: "Acme",
      state: "live",
      abilities: { chat: true, status: true, requests: true, decide: true },
      activity: { working: false, waiting: 2 },
      problem: null,
    });

    // The token is kept sealed, never as itself.
    const row = await env.DB.prepare("SELECT credential FROM third_parties").first<{
      credential: string;
    }>();
    expect(row?.credential).toMatch(/^v1\./);
    expect(row?.credential).not.toContain("rvp_");
  });

  it("renews a sign-in that runs out before using it, keeping the refresh token sealed", async () => {
    revnu.expire();
    expect(await signIn()).toMatch(/^\/t\//);
    const before = await env.DB.prepare(
      "SELECT credential, refresh, client_id, expires_at FROM third_parties",
    ).first<{ credential: string; refresh: string; client_id: string; expires_at: string }>();
    expect(before?.refresh).toMatch(/^v1\./);
    expect(before?.refresh).not.toContain("rf_");
    expect(before?.client_id).toBe("client_1");

    // Due within the minute, so asking it anything renews it first.
    const [party] = (await list()).parties;
    expect(party).toMatchObject({ state: "live", problem: null });
    expect(revnu.renewals()).toBe(1);
    const after = await env.DB.prepare("SELECT credential, expires_at FROM third_parties").first<{
      credential: string;
      expires_at: string;
    }>();
    expect(after?.credential).not.toBe(before?.credential);
    expect(Date.parse(after?.expires_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(before?.expires_at ?? ""),
    );
  });

  it("lets two requests renewing at once both carry on with the one that won", async () => {
    revnu.expire();
    await signIn();
    const both = await Promise.all([list(), list()]);
    for (const listed of both) expect(listed.parties[0]).toMatchObject({ state: "live" });
    expect(revnu.renewals()).toBe(1);
  });

  it("calls a sign-in it can't renew revoked", async () => {
    revnu.expire();
    await signIn();
    revnu.forgetRefreshes();
    expect((await list()).parties[0]).toMatchObject({ state: "revoked" });
  });

  it("registers once per address, and again when Revnu forgets", async () => {
    await signIn();
    await signIn();
    expect(revnu.clients.size).toBe(1);
    // Connecting the same account again replaces it rather than listing it twice.
    expect((await list()).parties).toHaveLength(1);

    revnu.forgetClients();
    expect(await signIn()).toBe("error: It no longer knew Nibblets. Try connecting again.");
    // The stale client is dropped, so the next try registers anew.
    expect(await signIn()).toMatch(/^\/t\//);
    expect(revnu.clients.size).toBe(1);
  });

  it("uses each sign-in once, and only before it expires", async () => {
    const back = revnu.approve(await startSignIn());
    const state = (await comeBack(back)).searchParams.get("third-party-finish") ?? "";
    expect((await comeBack(back)).searchParams.get("third-party-error")).toBe(
      "That sign-in has expired or was already used. Try again.",
    );
    expect((await finish(state)).status).toBe(200);
    expect((await finish(state)).status).toBe(400);

    const stale = revnu.approve(await startSignIn());
    await sweepThirdPartySignIns(env, Date.now() + 11 * 60_000);
    expect((await comeBack(stale)).searchParams.has("third-party-error")).toBe(true);
  });

  it("won't connect someone else's approval to the account that sent them the link", async () => {
    // Someone else starts signing in on their own account and sends the link on.
    const authorize = await startSignIn();
    await env.DB.prepare(
      "INSERT INTO users (id, name, created_at) VALUES ('mallory', 'M', '2026-01-01') ON CONFLICT DO NOTHING",
    ).run();
    await env.DB.prepare("UPDATE third_party_sign_ins SET user_id = 'mallory'").run();
    // Their victim approves it and comes back, signed in as themselves.
    const state = (await comeBack(revnu.approve(authorize))).searchParams.get("third-party-finish");
    const res = await finish(state ?? "");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "That sign-in has expired, was already used, or was started by someone else.",
    });
    const { results } = await env.DB.prepare("SELECT user_id FROM third_parties").all();
    expect(results).toEqual([]);
  });

  it("says so when the person doesn't allow it", async () => {
    const authorize = new URL(await startSignIn());
    const res = await call(
      `/v1/third-parties/callback?${new URLSearchParams({ error: "access_denied", state: authorize.searchParams.get("state") ?? "" })}`,
    );
    const location = new URL(res.headers.get("location") ?? "", LOCAL);
    expect(location.searchParams.get("third-party-error")).toBe("Revnu wasn't allowed.");
    expect((await list()).parties).toEqual([]);
  });

  it("connects with a pasted token too, refusing one Revnu doesn't know", async () => {
    const bad = await call("/v1/third-parties/kinds/revnu/token", {
      method: "POST",
      body: JSON.stringify({ token: "rvp_nope" }),
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({
      error: "Revnu no longer takes this connection. Connect it again in Settings.",
    });
    expect((await list()).parties).toEqual([]);
  });

  it("talks to it and answers its cards", async () => {
    const id = (await signIn()).replace("/t/", "");
    const send = () =>
      call(`/v1/third-parties/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "Find UK fintechs", clientId: "web-0000001" }),
      });
    expect((await send()).status).toBe(200);
    // A retry with the same client id is the same message.
    expect((await send()).status).toBe(200);
    expect(revnu.sent).toHaveLength(1);

    const thread = z
      .object({ messages: z.array(ThirdPartyMessage) })
      .parse(await (await call(`/v1/third-parties/${id}/thread`)).json());
    expect(thread.messages.map((m) => [m.role, m.text])).toEqual([["person", "Find UK fintechs"]]);
    expect((await list()).parties[0]?.activity).toEqual({ working: true, waiting: 2 });

    const requests = z
      .object({ requests: z.array(ThirdPartyRequest) })
      .parse(await (await call(`/v1/third-parties/${id}/requests`)).json());
    expect(requests.requests[0]?.actions[0]).toMatchObject({
      id: "approve",
      label: "Approve & Publish",
      effect: "ships",
    });
    const acted = await call(`/v1/third-parties/${id}/requests/k0/actions/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(acted.status).toBe(200);
    expect(revnu.answered).toEqual(["k0"]);
    expect((await list()).parties[0]?.activity?.waiting).toBe(1);
  });

  it("marks it revoked when Revnu stops taking it, and stops asking", async () => {
    const id = (await signIn()).replace("/t/", "");
    revnu.revokeAll();
    const res = await call(`/v1/third-parties/${id}/thread`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ revoked: true });
    expect((await list()).parties[0]).toMatchObject({ state: "revoked", activity: null });

    // Signing in again brings the same one back to life.
    expect(await signIn()).toBe(`/t/${id}`);
    expect((await list()).parties[0]?.state).toBe("live");
  });

  it("keeps each person's to themselves", async () => {
    const id = (await signIn()).replace("/t/", "");
    await env.DB.prepare(
      "INSERT INTO users (id, name, created_at) VALUES ('someone-else', 'S', '2026-01-01') ON CONFLICT DO NOTHING",
    ).run();
    await env.DB.prepare("UPDATE third_parties SET user_id = 'someone-else'").run();
    expect((await list()).parties).toEqual([]);
    expect((await call(`/v1/third-parties/${id}/thread`)).status).toBe(404);
    expect((await call(`/v1/third-parties/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("won't open a credential copied onto another row", async () => {
    await signIn();
    const row = await env.DB.prepare("SELECT credential FROM third_parties").first<{
      credential: string;
    }>();
    await env.DB.prepare(
      "INSERT INTO third_parties (id, user_id, plugin, ref, account, credential, abilities, connected_at) VALUES ('tp_copy', 'astrid', 'revnu', 'other', 'Copy', ?, ?, ?)",
    )
      .bind(
        row?.credential ?? "",
        JSON.stringify({ chat: true, status: true, requests: true, decide: true }),
        new Date().toISOString(),
      )
      .run();
    const res = await call("/v1/third-parties/tp_copy/thread");
    expect(res.status).toBe(502);
  });

  it("forgets one", async () => {
    const id = (await signIn()).replace("/t/", "");
    expect((await call(`/v1/third-parties/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await list()).parties).toEqual([]);
  });

  it("is off without a key to seal with", async () => {
    const off = { ...env, THIRD_PARTY_KEY: "" };
    const listed = ThirdPartyList.parse(
      await (await app.fetch(new Request(`${LOCAL}/v1/third-parties`), off)).json(),
    );
    expect(listed.enabled).toBe(false);
    const res = await app.fetch(
      new Request(`${LOCAL}/v1/third-parties/kinds/revnu/sign-in`, { method: "POST" }),
      off,
    );
    expect(res.status).toBe(422);
  });
});
