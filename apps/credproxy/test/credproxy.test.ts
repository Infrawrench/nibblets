import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp, placeholderCodexAuth, placeholderJwt, presentsKey } from "../src/app.ts";
import { anthropicProvider, mergeBetas } from "../src/providers/anthropic.ts";
import { deepseekProvider } from "../src/providers/deepseek.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { fileSource } from "../src/sources/file.ts";
import type { CredentialSource } from "../src/sources/source.ts";
import { TokenManager } from "../src/tokens.ts";

const KEY = "runner-key-0123456789";
const ADMIN = "admin-key-0123456789";
const HOUR = 60 * 60 * 1000;

function claudeDoc(access: string, refresh: string, expiresAt: number) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
    somethingElse: { keep: true },
  });
}

function memorySource(
  initial: string | null,
): CredentialSource & { text: string | null; saves: number } {
  const s = {
    kind: "file" as const,
    text: initial,
    saves: 0,
    async load() {
      return s.text;
    },
    async save(text: string) {
      s.text = text;
      s.saves++;
    },
    writable: () => true,
    describe: () => "memory",
  };
  return s;
}

type FetchArgs = Parameters<typeof fetch>;
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (...[input, init]: FetchArgs) => handler(String(input), init ?? {}));
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("mergeBetas", () => {
  it("adds the OAuth beta once, keeping existing ones in order", () => {
    expect(mergeBetas(null, "oauth-2025-04-20")).toBe("oauth-2025-04-20");
    expect(mergeBetas("a, b,oauth-2025-04-20", "oauth-2025-04-20")).toBe("a,b,oauth-2025-04-20");
    expect(mergeBetas("a,,a", "b")).toBe("a,b");
  });
});

describe("presentsKey", () => {
  it("accepts x-api-key, a bearer, and a placeholder JWT", () => {
    expect(presentsKey(new Headers({ "x-api-key": KEY }), KEY)).toBe(true);
    expect(presentsKey(new Headers({ authorization: `Bearer ${KEY}` }), KEY)).toBe(true);
    expect(presentsKey(new Headers({ authorization: `Bearer ${placeholderJwt(KEY)}` }), KEY)).toBe(
      true,
    );
  });
  it("rejects anything else", () => {
    expect(presentsKey(new Headers(), KEY)).toBe(false);
    expect(presentsKey(new Headers({ "x-api-key": "nope" }), KEY)).toBe(false);
    expect(
      presentsKey(new Headers({ authorization: `Bearer ${placeholderJwt("other")}` }), KEY),
    ).toBe(false);
  });
});

describe("TokenManager", () => {
  it("shares one refresh between concurrent callers and writes back every field", async () => {
    const source = memorySource(claudeDoc("old", "r1", Date.now() - 1000));
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    });
    const m = new TokenManager({ provider: anthropicProvider(), source, fetch });
    const results = await Promise.all([m.get(), m.get(), m.get()]);
    expect(calls).toBe(1);
    expect(results.map((t) => t.accessToken)).toEqual(["new", "new", "new"]);
    expect(source.saves).toBe(1);
    const saved = JSON.parse(source.text ?? "{}");
    expect(saved.claudeAiOauth.accessToken).toBe("new");
    expect(saved.claudeAiOauth.refreshToken).toBe("r2");
    expect(saved.claudeAiOauth.rateLimitTier).toBe("default_claude_max_20x");
    expect(saved.somethingElse).toEqual({ keep: true });
  });

  it("uses a token the host already refreshed instead of refreshing again", async () => {
    const source = memorySource(claudeDoc("old", "r1", Date.now() + HOUR));
    const fetch = mockFetch(() => Response.json({ access_token: "x" }));
    const m = new TokenManager({ provider: anthropicProvider(), source, fetch });
    expect((await m.get()).accessToken).toBe("old");
    source.text = claudeDoc("host-refreshed", "r9", Date.now() + HOUR);
    expect((await m.rejected("old")).accessToken).toBe("host-refreshed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes when upstream rejects the current token", async () => {
    const source = memorySource(claudeDoc("old", "r1", Date.now() + HOUR));
    const fetch = mockFetch(() =>
      Response.json({ access_token: "new", refresh_token: "r2", expires_in: 60 }),
    );
    const m = new TokenManager({ provider: anthropicProvider(), source, fetch });
    await m.get();
    expect((await m.rejected("old")).accessToken).toBe("new");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports a missing login without throwing", async () => {
    const m = new TokenManager({ provider: anthropicProvider(), source: memorySource(null) });
    const status = await m.status();
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/Not signed in/);
  });
});

describe("keychainSource", () => {
  it("won't refresh when the bridge is away, so the host keeps its login", async () => {
    const { keychainSource } = await import("../src/sources/keychain.ts");
    const fetch = mockFetch(() => {
      throw new Error("connection refused");
    });
    const source = keychainSource({
      provider: "anthropic",
      bridgeUrl: "http://bridge",
      bridgeToken: "t",
      fetch,
    });
    source.remember(claudeDoc("old", "r1", Date.now() - 1000));
    const refresh = mockFetch(() => Response.json({ access_token: "new" }));
    const m = new TokenManager({ provider: anthropicProvider(), source, fetch: refresh });
    await expect(m.get()).rejects.toThrow(/Open the Nibblets app/);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("fileSource", () => {
  it("writes in place, keeping fields it doesn't know", async () => {
    const dir = await mkdtemp(join(tmpdir(), "credproxy-"));
    const path = join(dir, "auth.json");
    await writeFile(
      path,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: placeholderJwt("x", "acct-1"),
          access_token: "a",
          refresh_token: "r",
          account_id: "acct-1",
        },
        last_refresh: "2026-01-01T00:00:00Z",
        extra: 1,
      }),
    );
    const provider = openaiProvider();
    const source = fileSource(path);
    const text = (await source.load()) ?? "";
    const tokens = provider.parse(text);
    expect(tokens.accountId).toBe("acct-1");
    await source.save(provider.merge(text, { ...tokens, accessToken: "a2", refreshToken: "r2" }));
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.tokens.access_token).toBe("a2");
    expect(saved.tokens.refresh_token).toBe("r2");
    expect(saved.tokens.account_id).toBe("acct-1");
    expect(saved.extra).toBe(1);
    expect(saved.auth_mode).toBe("chatgpt");
  });
});

describe("proxy", () => {
  function setup(
    upstream: (url: string, init: RequestInit) => Response | Promise<Response>,
    deepseekKey: string | null = "sk-deepseek",
  ) {
    const fetch = mockFetch(upstream);
    const anthropic = new TokenManager({
      provider: anthropicProvider("https://anthropic.test"),
      source: memorySource(claudeDoc("real-access", "r1", Date.now() + HOUR)),
      fetch,
    });
    const openai = new TokenManager({
      provider: openaiProvider("https://chatgpt.test/backend-api/codex"),
      source: memorySource(
        JSON.stringify({
          tokens: {
            id_token: placeholderJwt("x", "acct-9"),
            access_token: "oa-access",
            refresh_token: "r",
          },
        }),
      ),
      fetch,
    });
    const app = createApp({
      key: KEY,
      adminKey: ADMIN,
      anthropic,
      openai,
      deepseek: deepseekProvider(deepseekKey, "https://deepseek.test/anthropic"),
      push: () => false,
      fetch,
    });
    return { app, fetch };
  }

  it("swaps the runner key for the real Anthropic token and merges betas", async () => {
    const { app, fetch } = setup(
      () => new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await app.request("/anthropic/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
      body: JSON.stringify({ model: "claude-opus-5-5" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hi\n\n");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://anthropic.test/v1/messages?beta=true");
    const sent = init ?? {};
    expect(header(sent, "authorization")).toBe("Bearer real-access");
    expect(header(sent, "x-api-key")).toBeNull();
    expect(header(sent, "anthropic-beta")).toBe(
      "fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20",
    );
    expect(header(sent, "anthropic-version")).toBe("2023-06-01");
  });

  it("swaps the runner key for the DeepSeek API key", async () => {
    const { app, fetch } = setup(
      () => new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await app.request("/deepseek/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": KEY, authorization: "Bearer stray" },
      body: JSON.stringify({ model: "deepseek-v4-pro" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hi\n\n");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://deepseek.test/anthropic/v1/messages?beta=true");
    expect(header(init ?? {}, "x-api-key")).toBe("sk-deepseek");
    expect(header(init ?? {}, "authorization")).toBeNull();
    expect(header(init ?? {}, "anthropic-version")).toBe("2023-06-01");
  });

  it("says so when there's no DeepSeek API key, and keeps the runner key out", async () => {
    const { app, fetch } = setup(() => new Response("{}"), null);
    const res = await app.request("/deepseek/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });
    expect(res.status).toBe(503);
    const bad = await setup(() => new Response("{}")).app.request("/deepseek/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps OpenAI paths onto the ChatGPT backend with the account id", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const auth = placeholderCodexAuth(KEY);
    await app.request("/openai/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.tokens.access_token}`,
        "chatgpt-account-id": "nibblet",
      },
      body: "{}",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://chatgpt.test/backend-api/codex/responses");
    expect(header(init ?? {}, "authorization")).toBe("Bearer oa-access");
    expect(header(init ?? {}, "chatgpt-account-id")).toBe("acct-9");
  });

  it("refuses requests without the runner key", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const res = await app.request("/anthropic/v1/messages", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries once with a refreshed token after a 401", async () => {
    let n = 0;
    const { app } = setup((url) => {
      if (url.includes("oauth/token"))
        return Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
      n++;
      return new Response(n === 1 ? "no" : "yes", { status: n === 1 ? 401 : 200 });
    });
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("yes");
  });

  it("guards status and admin pushes with the admin key", async () => {
    const { app } = setup(() => new Response("{}"));
    expect((await app.request("/status")).status).toBe(401);
    const res = await app.request("/status", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(3);
    expect(body).toContainEqual(
      expect.objectContaining({ provider: "deepseek", source: "env", ok: true }),
    );
    const push = await app.request("/admin/credentials/anthropic", {
      method: "PUT",
      headers: { authorization: `Bearer ${ADMIN}` },
      body: claudeDoc("a", "b", 0),
    });
    expect(push.status).toBe(409);
  });

  it("answers Codex refreshes of the placeholder login", async () => {
    const { app } = setup(() => new Response("{}"));
    const ok = await app.request("/openai-auth/oauth/token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: KEY }),
    });
    expect(ok.status).toBe(200);
    const bad = await app.request("/openai-auth/oauth/token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: "nope" }),
    });
    expect(bad.status).toBe(401);
  });
});
