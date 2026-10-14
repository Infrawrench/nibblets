import { placeholderCodexAuth, placeholderCodexRefresh, placeholderJwt } from "@nibblet/protocol";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { jwtClaims } from "./providers/provider.ts";
import { anthropicLimit, openaiLimit } from "./limits.ts";
import { NoCredentialError, type TokenManager } from "./tokens.ts";

export interface AppOptions {
  /** The key runners present. */
  key: string;
  /** The key the server and the desktop app present. */
  adminKey: string;
  anthropic: TokenManager;
  openai: TokenManager;
  /** Called with a pushed document; returns false when the provider has no keychain source. */
  push(provider: "anthropic" | "openai", text: string): boolean;
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
 * Whether a request carries the runner key. Harnesses send their "API key"
 * in different places: Claude Code as `Authorization: Bearer` (from
 * ANTHROPIC_AUTH_TOKEN) or `x-api-key` (from ANTHROPIC_API_KEY), OpenCode as
 * `x-api-key`, and Codex as `Authorization: Bearer <placeholder JWT>` whose
 * `nibblet_key` claim is the key.
 */
export function presentsKey(headers: Headers, key: string): boolean {
  const apiKey = headers.get("x-api-key");
  if (apiKey && same(apiKey, key)) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]?.trim();
  if (!bearer) return false;
  if (same(bearer, key)) return true;
  const claim = jwtClaims(bearer)?.nibblet_key;
  return typeof claim === "string" && same(claim, key);
}

export function createApp(opts: AppOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const app = new Hono();

  const admin = (c: Context) => presentsKey(c.req.raw.headers, opts.adminKey);

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/status", async (c) => {
    if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await Promise.all([opts.anthropic.status(), opts.openai.status()]));
  });

  app.put("/admin/credentials/:provider", async (c) => {
    if (!admin(c)) return c.json({ error: "unauthorized" }, 401);
    const provider = c.req.param("provider");
    if (provider !== "anthropic" && provider !== "openai")
      return c.json({ error: "unknown provider" }, 404);
    const text = await c.req.text();
    const manager = provider === "anthropic" ? opts.anthropic : opts.openai;
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
    if (!presentsKey(c.req.raw.headers, opts.key)) return c.json({ error: "unauthorized" }, 401);
    return c.json(placeholderCodexAuth(opts.key));
  });

  app.post("/openai-auth/oauth/token", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const refresh =
      typeof body === "object" && body !== null && "refresh_token" in body
        ? body.refresh_token
        : null;
    if (typeof refresh !== "string" || !same(refresh, opts.key)) {
      return c.json({ error: "invalid_grant" }, 401);
    }
    return c.json(placeholderCodexRefresh(opts.key));
  });

  const forward = (prefix: string, manager: TokenManager) => async (c: Context) => {
    const req = c.req.raw;
    if (!presentsKey(req.headers, opts.key)) {
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

  app.all("/anthropic/*", forward("/anthropic", opts.anthropic));
  app.all("/openai/*", forward("/openai", opts.openai));

  return app;
}
