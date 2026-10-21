import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetStatus, MeteredRequest } from "@nibblet/protocol";
import { nibbletProxyKey } from "@nibblet/protocol/proxy-key";
import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  placeholderCodexAuth,
  placeholderJwt,
  presentsKey,
  runnerOf,
} from "../src/app.ts";
import { BudgetGate, serverBudgets, type BudgetClient } from "../src/budgets.ts";
import { anthropicProvider, mergeBetas } from "../src/providers/anthropic.ts";
import { anthropicKeyProvider, openaiKeyProvider } from "../src/providers/apikey.ts";
import { deepseekProvider } from "../src/providers/deepseek.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { fileSource } from "../src/sources/file.ts";
import type { CredentialSource } from "../src/sources/source.ts";
import { TokenManager } from "../src/tokens.ts";

const KEY = "runner-key-0123456789";
const ADMIN = "admin-key-0123456789";
const HOUR = 60 * 60 * 1000;
/** What a nibblet's container presents: the shared secret, signed for it. */
const NIB_KEY = nibbletProxyKey(KEY, "nib_a");

/** A server that knows `status` for every nibblet, and adds nothing up. */
function fakeServer(status: Partial<BudgetStatus> = {}) {
  const reports: MeteredRequest[] = [];
  const checked: string[] = [];
  const answer = (nibbletId: string): BudgetStatus => ({
    nibbletId,
    budgetUsd: null,
    spentUsd: 0,
    month: "2026-10",
    resetsAt: "2026-11-01T00:00:00.000Z",
    allowed: true,
    ...status,
  });
  const client: BudgetClient = {
    async check(nibbletId) {
      checked.push(nibbletId);
      return answer(nibbletId);
    },
    async report(request) {
      reports.push(request);
      return answer(request.nibbletId);
    },
  };
  return { client, reports, checked };
}

function fakeBudgets(status: Partial<BudgetStatus> = {}) {
  const server = fakeServer(status);
  return { ...server, gate: new BudgetGate(server.client, { retryMs: 1, log: () => {} }) };
}

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

describe("runnerOf", () => {
  it("knows a nibblet's key, wherever the harness puts it", () => {
    expect(runnerOf(new Headers({ "x-api-key": NIB_KEY }), KEY)?.nibbletId).toBe("nib_a");
    expect(
      runnerOf(new Headers({ authorization: `Bearer ${placeholderJwt(NIB_KEY)}` }), KEY)?.nibbletId,
    ).toBe("nib_a");
    expect(runnerOf(new Headers({ "x-api-key": KEY }), KEY)).toEqual({ key: KEY, nibbletId: null });
  });
  it("won't take a key signed with another secret, or another nibblet's id with this one's signature", () => {
    expect(
      runnerOf(new Headers({ "x-api-key": nibbletProxyKey("other-secret", "nib_a") }), KEY),
    ).toBeNull();
    const forged = `nib_b.${NIB_KEY.split(".")[1]}`;
    expect(runnerOf(new Headers({ "x-api-key": forged }), KEY)).toBeNull();
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
      budgets: fakeBudgets().gate,
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
      headers: { "x-api-key": NIB_KEY, authorization: "Bearer stray" },
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
      headers: { "x-api-key": NIB_KEY },
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

  it("takes a nibblet's own key on a subscription", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
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

  it("answers Codex refreshes of the placeholder login, keeping its key", async () => {
    const { app } = setup(() => new Response("{}"));
    const ok = await app.request("/openai-auth/oauth/token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: KEY }),
    });
    expect(ok.status).toBe(200);
    const mine = await app.request("/openai-auth/oauth/token", {
      method: "POST",
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: NIB_KEY }),
    });
    expect(((await mine.json()) as { refresh_token: string }).refresh_token).toBe(NIB_KEY);
    const bad = await app.request("/openai-auth/oauth/token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: "nope" }),
    });
    expect(bad.status).toBe(401);
  });
});

describe("proxy on API keys", () => {
  function setup(
    upstream: (url: string, init: RequestInit) => Response | Promise<Response>,
    budgets = fakeBudgets(),
  ) {
    const fetch = mockFetch(upstream);
    const app = createApp({
      key: KEY,
      adminKey: ADMIN,
      anthropic: anthropicKeyProvider("sk-ant-key", "https://anthropic.test"),
      openai: openaiKeyProvider("sk-openai-key", "https://openai.test/v1"),
      deepseek: deepseekProvider(null),
      push: () => false,
      budgets: budgets.gate,
      fetch,
    });
    return { app, fetch, budgets };
  }

  it("swaps the runner key for the Anthropic API key, without the OAuth beta", async () => {
    const { app, fetch } = setup(() => new Response("data: hi\n\n"));
    const res = await app.request("/anthropic/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY, "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hi\n\n");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://anthropic.test/v1/messages?beta=true");
    const sent = init ?? {};
    expect(header(sent, "x-api-key")).toBe("sk-ant-key");
    expect(header(sent, "authorization")).toBeNull();
    expect(header(sent, "anthropic-beta")).toBe("fine-grained-tool-streaming-2025-05-14");
  });

  it("sends Codex to the OpenAI API with the API key and no ChatGPT account", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const auth = placeholderCodexAuth(NIB_KEY);
    await app.request("/openai/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.tokens.access_token}`,
        "chatgpt-account-id": "nibblet",
      },
      body: "{}",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://openai.test/v1/responses");
    expect(header(init ?? {}, "authorization")).toBe("Bearer sk-openai-key");
    expect(header(init ?? {}, "chatgpt-account-id")).toBeNull();
  });

  it("passes a 401 straight back rather than refreshing", async () => {
    const { app, fetch } = setup(() => new Response("bad key", { status: 401 }));
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("still refuses requests without the runner key", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const res = await app.request("/openai/responses", {
      method: "POST",
      headers: { authorization: "Bearer sk-someone-elses" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the keys as from the environment, and refuses keychain pushes", async () => {
    const { app } = setup(() => new Response("{}"));
    const body = await (
      await app.request("/status", { headers: { authorization: `Bearer ${ADMIN}` } })
    ).json();
    expect(body).toContainEqual(
      expect.objectContaining({ provider: "anthropic", source: "env", ok: true }),
    );
    expect(body).toContainEqual(
      expect.objectContaining({ provider: "openai", source: "env", ok: true }),
    );
    const push = await app.request("/admin/credentials/anthropic", {
      method: "PUT",
      headers: { authorization: `Bearer ${ADMIN}` },
      body: claudeDoc("a", "b", 0),
    });
    expect(push.status).toBe(409);
  });

  it("says which variable to set when the key is missing", async () => {
    const res = await createApp({
      key: KEY,
      adminKey: ADMIN,
      anthropic: anthropicKeyProvider(null),
      openai: openaiKeyProvider(null),
      deepseek: deepseekProvider(null),
      push: () => false,
      budgets: fakeBudgets().gate,
    }).request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(anthropicKeyProvider(null).status()).toMatchObject({
      ok: false,
      source: "none",
      detail: "NIBBLET_ANTHROPIC_API_KEY isn't set",
    });
  });

  it("needs a nibblet's own key, so the spending goes to someone", async () => {
    const { app, fetch } = setup(() => new Response("{}"));
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Restart it/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a nibblet that has spent its budget, saying so", async () => {
    const budgets = fakeBudgets({ allowed: false, budgetUsd: 10, spentUsd: 10.25 });
    const { app, fetch } = setup(() => new Response("{}"), budgets);
    const res = await app.request("/openai/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${placeholderJwt(NIB_KEY)}` },
      body: "{}",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/monthly budget \(\$10\.25 of \$10\.00\).*2026-11-01/);
    expect(budgets.checked).toEqual(["nib_a"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses rather than spends when the budget can't be checked", async () => {
    const budgets = fakeBudgets();
    budgets.client.check = async () => {
      throw new Error("connection refused");
    };
    const { app, fetch } = setup(() => new Response("{}"), budgets);
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    expect(res.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports what a streamed Claude response used, once it ends", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
            output_tokens: 1,
          },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 512, server_tool_use: { web_search_requests: 2 } },
      })}\n\n`,
    ].join("");
    const { app, budgets } = setup(
      () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    expect(await res.text()).toBe(sse);
    expect(budgets.reports).toEqual([
      {
        nibbletId: "nib_a",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2000,
          cacheWriteTokens: 100,
          cacheWrite1hTokens: 200,
          outputTokens: 512,
          webSearches: 2,
        },
      },
    ]);
  });

  it("reports what a Codex response used, with cached input apart", async () => {
    const completed = {
      type: "response.completed",
      response: {
        model: "gpt-6-sol-2026-09-01",
        output: [{ type: "web_search_call" }, { type: "message" }],
        usage: {
          input_tokens: 5000,
          input_tokens_details: { cached_tokens: 4000 },
          output_tokens: 70,
        },
      },
    };
    const sse = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
    const { app, budgets } = setup(
      () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    );
    await (
      await app.request("/openai/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${placeholderJwt(NIB_KEY)}` },
        body: "{}",
      })
    ).text();
    expect(budgets.reports[0]).toMatchObject({
      provider: "openai",
      model: "gpt-6-sol-2026-09-01",
      usage: { inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 70, webSearches: 1 },
    });
  });

  it("reports a plain JSON response, and nothing for one without usage", async () => {
    const { app, budgets } = setup((url) =>
      url.includes("count_tokens")
        ? Response.json({ input_tokens: 99 })
        : Response.json({
            model: "claude-haiku-5-5",
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
    );
    for (const path of ["/anthropic/v1/messages", "/anthropic/v1/messages/count_tokens"]) {
      await (
        await app.request(path, { method: "POST", headers: { "x-api-key": NIB_KEY }, body: "{}" })
      ).text();
    }
    expect(budgets.reports).toHaveLength(1);
    expect(budgets.reports[0]?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it("still counts a stream the harness stopped reading", async () => {
    const start = `data: ${JSON.stringify({
      type: "message_start",
      message: { model: "claude-sonnet-5-5", usage: { input_tokens: 40000, output_tokens: 1 } },
    })}\n\n`;
    const { app, budgets } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(start));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: "{}",
    });
    const reader = res.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(budgets.reports[0]?.usage.inputTokens).toBe(40000);
  });

  it("counts nothing for a request the API refused", async () => {
    const { app, budgets } = setup(() =>
      Response.json({ type: "error", error: { type: "overloaded_error" } }, { status: 529 }),
    );
    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": NIB_KEY },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
    });
    expect(res.status).toBe(529);
    await res.text();
    expect(budgets.reports).toEqual([]);
  });
});

describe("serverBudgets", () => {
  it("asks the server with the admin key, and reads its answer", async () => {
    const status = {
      nibbletId: "nib_a",
      budgetUsd: 5,
      spentUsd: 1,
      month: "2026-10",
      resetsAt: "2026-11-01T00:00:00.000Z",
      allowed: true,
    };
    const fetch = mockFetch(() => Response.json(status));
    const client = serverBudgets({ serverUrl: "http://server:8420/", adminKey: ADMIN, fetch });
    expect(await client.check("nib_a")).toEqual(status);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://server:8420/credproxy/budget/nib_a");
    expect(header(init ?? {}, "authorization")).toBe(`Bearer ${ADMIN}`);
  });

  it("fails rather than guess when the server says no", async () => {
    const client = serverBudgets({
      serverUrl: "http://server:8420",
      adminKey: ADMIN,
      fetch: mockFetch(() => new Response("nope", { status: 500 })),
    });
    await expect(client.check("nib_a")).rejects.toThrow(/500/);
  });
});
