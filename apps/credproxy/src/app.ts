import { placeholderCodexAuth, placeholderCodexRefresh, placeholderJwt } from "@nibblet/protocol";
import { proxyKeyOwner } from "@nibblet/protocol/proxy-key";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { budgetSpentMessage, type BudgetGate } from "./budgets.ts";
import { estimateRequest, meter, type Dialect } from "./meter.ts";
import { jwtClaims } from "./providers/provider.ts";
import type { ApiKeyProvider } from "./providers/apikey.ts";
import { anthropicLimit, openaiLimit } from "./limits.ts";
import { NoCredentialError, TokenManager } from "./tokens.ts";

export interface AppOptions {
  /**
   * The proxy's shared secret. Runners present a key made from it for their
   * nibblet (`@nibblet/protocol/proxy-key`); the bare secret works too, on a
   * subscription, but not on an API key, whose spending has to go to someone.
   */
  key: string;
  /** The key the server and the desktop app present. */
  adminKey: string;
  /** A subscription login, or an API key when the user chose one instead. */
  anthropic: TokenManager | ApiKeyProvider;
  openai: TokenManager | ApiKeyProvider;
  deepseek: ApiKeyProvider;
  /** Called with a pushed document; returns false when the provider has no keychain source. */
  push(provider: "anthropic" | "openai", text: string): boolean;
  /** Nibblets' budgets for API-key usage, which the server keeps. */
  budgets: BudgetGate;
  fetch?: typeof globalThis.fetch;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

export { placeholderCodexAuth, placeholderJwt };

function same(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The keys a request carries. Harnesses send their "API key" in different
 * places: Claude Code as `Authorization: Bearer` (from ANTHROPIC_AUTH_TOKEN)
 * or `x-api-key` (from ANTHROPIC_API_KEY), OpenCode as `x-api-key`, and Codex
 * as `Authorization: Bearer <placeholder JWT>` whose `nibblet_key` claim is
 * the key.
 */
function presented(headers: Headers): string[] {
  const out: string[] = [];
  const apiKey = headers.get("x-api-key");
  if (apiKey) out.push(apiKey);
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]?.trim();
  if (bearer) {
    out.push(bearer);
    const claim = jwtClaims(bearer)?.nibblet_key;
    if (typeof claim === "string") out.push(claim);
  }
  return out;
}

/** Whether a request carries exactly this key. For the admin key. */
export function presentsKey(headers: Headers, key: string): boolean {
  return presented(headers).some((k) => same(k, key));
}

/** A runner's key, and the nibblet it's for (null for the bare shared secret). */
export interface Runner {
  key: string;
  nibbletId: string | null;
}

/** Which runner key a single value is, if it's one. */
export function runnerKey(value: string, secret: string): Runner | null {
  if (same(value, secret)) return { key: value, nibbletId: null };
  const nibbletId = proxyKeyOwner(secret, value);
  return nibbletId ? { key: value, nibbletId } : null;
}

/** The runner a request comes from, or null when it carries no runner key. */
export function runnerOf(headers: Headers, secret: string): Runner | null {
  for (const value of presented(headers)) {
    const runner = runnerKey(value, secret);
    if (runner) return runner;
  }
  return null;
}

export function createApp(opts: AppOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const app = new Hono();

  const admin = (c: Context) => presentsKey(c.req.raw.headers, opts.adminKey);

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/status", async (c) => {
    if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(
      await Promise.all([opts.anthropic.status(), opts.openai.status(), opts.deepseek.status()]),
    );
  });

  app.put("/admin/credentials/:provider", async (c) => {
    if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
    const provider = c.req.param("provider");
    if (provider !== "anthropic" && provider !== "openai")
      return c.json({ error: "unknown provider" }, 404);
    const text = await c.req.text();
    const manager = provider === "anthropic" ? opts.anthropic : opts.openai;
    if (!(manager instanceof TokenManager))
      return c.json({ error: `${provider} is using an API key` }, 409);
    try {
      manager.provider.parse(text);
    } catch (err) {
      return c.json({ error: `not a ${provider} login: ${String(err)}` }, 400);
    }
    if (!opts.push(provider, text))
      return c.json({ error: `${provider} isn't using the keychain` }, 409);
    manager.reset();
    return c.json(await manager.status());
  });

  app.get("/placeholder/codex-auth.json", (c) => {
    const runner = runnerOf(c.req.raw.headers, opts.key);
    if (!runner) return c.json({ error: "unauthorized" }, 401);
    return c.json(placeholderCodexAuth(runner.key));
  });

  app.post("/openai-auth/oauth/token", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const refresh =
      typeof body === "object" && body !== null && "refresh_token" in body
        ? body.refresh_token
        : null;
    // Answered with the same key, since Codex treats a new identity as an account switch.
    if (typeof refresh !== "string" || !runnerKey(refresh, opts.key)) {
      return c.json({ error: "invalid_grant" }, 401);
    }
    return c.json(placeholderCodexRefresh(refresh));
  });

  const forward = (prefix: string, manager: TokenManager) => async (c: Context) => {
    const req = c.req.raw;
    if (!runnerOf(req.headers, opts.key)) {
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "Bad nibblet key" } },
        401,
      );
    }
    const url = new URL(req.url);
    const target = manager.provider.upstream(url.pathname.slice(prefix.length) || "/", url.search);
    // Buffer the request so a 401 can be retried with a refreshed token.
    // Responses, which are the streamed half, pass straight through.
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();

    const send = (tokens: Awaited<ReturnType<TokenManager["get"]>>) => {
      const headers = new Headers(req.headers);
      for (const h of HOP_BY_HOP) headers.delete(h);
      headers.delete("authorization");
      headers.delete("x-api-key");
      // fetch would decompress but keep content-encoding, and the client
      // would then decompress twice; asking for identity sidesteps that.
      headers.set("accept-encoding", "identity");
      manager.provider.authorise(headers, tokens);
      return doFetch(target, { method: req.method, headers, body, redirect: "manual" });
    };

    let tokens;
    try {
      tokens = await manager.get();
    } catch (err) {
      const status = err instanceof NoCredentialError ? 503 : 502;
      return c.json(
        { type: "error", error: { type: "credential_error", message: String(err) } },
        status,
      );
    }
    let res = await send(tokens);
    if (res.status === 401) {
      await res.body?.cancel();
      try {
        res = await send(await manager.rejected(tokens.accessToken));
      } catch (err) {
        return c.json(
          { type: "error", error: { type: "credential_error", message: String(err) } },
          502,
        );
      }
    }
    const headers = new Headers(res.headers);
    for (const h of [...HOP_BY_HOP, "content-encoding"]) headers.delete(h);
    // Note usage limits on the way past, so the server can wait them out.
    // Only a 429's small JSON body is read; everything else streams through.
    const now = Date.now();
    let out: ReadableStream<Uint8Array> | string | null = res.body;
    let until: number | null;
    if (manager.provider.id === "openai" && res.status === 429) {
      const text = await res.text();
      out = text;
      until = openaiLimit(res.status, res.headers, text, now);
    } else {
      until =
        manager.provider.id === "anthropic"
          ? anthropicLimit(res.status, res.headers, now)
          : openaiLimit(res.status, res.headers, null, now);
    }
    if (until !== null) manager.noteLimit(until);
    else if (res.ok) manager.clearLimit();
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  };

  // An API key: no refresh to retry with and no subscription limit to note.
  // It costs money, though, so each request is checked against its nibblet's
  // budget first (counting its requests still under way), and the
  // response's usage is read on its way through and reported to the server.
  const forwardKey = (prefix: string, provider: ApiKeyProvider) => async (c: Context) => {
    const req = c.req.raw;
    const runner = runnerOf(req.headers, opts.key);
    if (!runner) {
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "Bad nibblet key" } },
        401,
      );
    }
    const { nibbletId } = runner;
    if (!nibbletId) {
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "This nibblet's container is from before API-key budgets. Restart it.",
          },
        },
        401,
      );
    }
    const dialect: Dialect = provider.id === "openai" ? "openai" : "anthropic";
    try {
      const verdict = await opts.budgets.check(nibbletId);
      if (!verdict.allowed) {
        const message = budgetSpentMessage(verdict.status, verdict.spentUsd);
        return c.json(budgetError(dialect, message), 402);
      }
    } catch (err) {
      return c.json(
        {
          type: "error",
          error: {
            type: "credential_error",
            message: `Couldn't check this nibblet's budget: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        503,
      );
    }
    const { key } = provider;
    if (!key) {
      return c.json(
        {
          type: "error",
          error: { type: "credential_error", message: `No ${provider.id} API key` },
        },
        503,
      );
    }
    const url = new URL(req.url);
    const target = provider.upstream(url.pathname.slice(prefix.length) || "/", url.search);
    const headers = new Headers(req.headers);
    for (const h of HOP_BY_HOP) headers.delete(h);
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set("accept-encoding", "identity");
    provider.authorise(headers, key);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    const estimate = estimateRequest(dialect, req.method, url.pathname, body);
    // Counted from now, so requests running at once see each other.
    const spending = opts.budgets.begin(nibbletId, provider.id, estimate);
    let res: Response;
    try {
      res = await doFetch(target, { method: req.method, headers, body, redirect: "manual" });
    } catch (err) {
      spending.finish(null);
      throw err;
    }
    const out = new Headers(res.headers);
    for (const h of [...HOP_BY_HOP, "content-encoding"]) out.delete(h);
    // A refused request costs nothing.
    if (!res.ok || !res.body) {
      spending.finish(null);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      });
    }
    const metered = meter(res.body, {
      dialect,
      contentType: res.headers.get("content-type"),
      estimate,
      progress: spending.progress,
      done: spending.finish,
    });
    return new Response(metered, { status: res.status, statusText: res.statusText, headers: out });
  };

  const route = (prefix: string, credential: TokenManager | ApiKeyProvider) =>
    credential instanceof TokenManager
      ? forward(prefix, credential)
      : forwardKey(prefix, credential);

  app.all("/anthropic/*", route("/anthropic", opts.anthropic));
  app.all("/openai/*", route("/openai", opts.openai));
  app.all("/deepseek/*", forwardKey("/deepseek", opts.deepseek));

  return app;
}

/** A refusal over budget, in the shape the harness's own API uses, so it shows the message. */
function budgetError(dialect: Dialect, message: string) {
  return dialect === "openai"
    ? { error: { type: "billing_error", code: "budget_exceeded", message } }
    : { type: "error", error: { type: "billing_error", message } };
}
