import { ThirdPartyError, ThirdPartyRevokedError } from "@nibblets/third-party";
import { ThirdPartyMessage, ThirdPartyRequest } from "@nibblets/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { notra, toActivity } from "./index.ts";

const TOKEN = "ntra_test";
const NOW = Date.parse("2026-10-27T09:00:00.000Z");

type Json = z.infer<ReturnType<typeof z.json>>;

interface Call {
  method: string;
  path: string;
  body: Json | null;
}

/** A part of a UI message: text, or a tool call. */
type UiPart = {
  type: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  input?: Json;
  approval?: { id: string };
};

/** A UI message as the AI SDK keeps it. */
type Ui = {
  id: string;
  role: string;
  parts: UiPart[];
  metadata?: { createdAt: string };
};

const said = (id: string, role: string, text: string, at: number): Ui => ({
  id,
  role,
  parts: [{ type: "text", text }],
  metadata: { createdAt: new Date(at).toISOString() },
});

const asking = (approvals: { name: string; id: string; input: Json }[]): Ui => ({
  id: "m_ask",
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "text", text: "I've drafted the changelog." },
    ...approvals.map((a) => ({
      type: `tool-${a.name}`,
      toolCallId: `call_${a.id}`,
      state: "approval-requested",
      input: a.input,
      approval: { id: a.id },
    })),
  ],
  metadata: { createdAt: new Date(NOW - 1000).toISOString() },
});

/** A Notra that answers as its API docs say, for one credential. */
function fakeNotra(authentication: object = { type: "apiKey" }, canReadChats = true) {
  const calls: Call[] = [];
  const chats: { chatId: string; externalChannelId: object | null; messages: Ui[] }[] = [
    // Someone's own chat in the dashboard, which isn't Nibblets'.
    { chatId: "chat_theirs", externalChannelId: null, messages: [said("x", "user", "Hi", NOW)] },
  ];
  let revoked = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? z.json().parse(JSON.parse(text)) : null;
    calls.push({ method: request.method, path: url.pathname, body });
    if (revoked || request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "Invalid API key", code: "INVALID_API_KEY" }, { status: 401 });
    }
    const summary = (c: (typeof chats)[number]) => ({
      chatId: c.chatId,
      title: "Chat",
      createdAt: "2026-10-27T08:00:00.000Z",
      updatedAt: "2026-10-27T08:30:00.000Z",
      pinnedAt: null,
      externalChannelId: c.externalChannelId,
    });
    const streamed = (chatId: string) =>
      new Response('{"type":"start","messageMetadata":{"chatId":"' + chatId + '"}}\n', {
        headers: { "content-type": "text/event-stream", "x-chat-id": chatId },
      });
    const Send = z.object({
      message: z.string().optional(),
      externalChannelId: z.object({ source: z.string(), id: z.string() }).optional(),
      approvals: z.array(z.object({ id: z.string(), approved: z.boolean() })).optional(),
    });
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /v1/me/workspaces") {
      return Response.json({
        currentWorkspace: { id: "org_1", slug: "acme", name: "Acme", logo: null },
        workspaces: [],
        authentication,
      });
    }
    if (route.startsWith("GET /v1/chats") && !canReadChats) {
      return Response.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403 });
    }
    if (route === "GET /v1/chats") return Response.json({ chats: chats.map(summary) });
    if (route === "POST /v1/chats") {
      const sent = Send.parse(body);
      const chat = {
        chatId: `chat_${chats.length + 1}`,
        externalChannelId: sent.externalChannelId ?? null,
        messages: [said("u1", "user", sent.message ?? "", NOW)],
      };
      chats.push(chat);
      return streamed(chat.chatId);
    }
    const chat = chats.find((c) => url.pathname === `/v1/chats/${c.chatId}`);
    if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
    if (request.method === "GET") {
      return Response.json({ chat: summary(chat), messages: chat.messages });
    }
    const sent = Send.parse(body);
    if (sent.message)
      chat.messages.push(said(`u${chat.messages.length}`, "user", sent.message, NOW));
    return streamed(chat.chatId);
  };
  return {
    fetch,
    calls,
    chats,
    revoke: () => {
      revoked = true;
    },
    /** Notra's reply in Nibblets' chat. */
    reply: (message: Ui) => chats.find((c) => c.externalChannelId)?.messages.push(message),
  };
}

const ALL = { chat: true, status: true, requests: true, decide: true };

afterEach(() => {
  vi.useRealTimers();
});

describe("Notra", () => {
  it("connects a workspace with what its OAuth access level allows", async () => {
    const full = fakeNotra({
      type: "oauth",
      accountId: "u_1",
      scopes: ["chats.read", "chats.write", "posts.read"],
    });
    expect(await notra.identify(TOKEN, full)).toEqual({
      ref: "org_1",
      account: "Acme",
      abilities: ALL,
    });
    const readOnly = fakeNotra({ type: "oauth", accountId: "u_1", scopes: ["chats.read"] });
    expect((await notra.identify(TOKEN, readOnly)).abilities).toEqual({
      chat: false,
      status: true,
      requests: true,
      decide: false,
    });
    const writeOnly = fakeNotra({ type: "oauth", accountId: "u_1", scopes: ["chats.write"] });
    await expect(notra.identify(TOKEN, writeOnly)).rejects.toThrow("can't read Notra's chats");
  });

  it("asks whether an API key can read chats, since it doesn't say", async () => {
    expect((await notra.identify(TOKEN, fakeNotra())).abilities).toEqual(ALL);
    await expect(notra.identify(TOKEN, fakeNotra({ type: "apiKey" }, false))).rejects.toThrow(
      "can't read Notra's chats",
    );
    await expect(notra.identify("ntra_wrong", fakeNotra())).rejects.toThrow(ThirdPartyRevokedError);
  });

  it("starts a chat of its own on the first message, then carries it on", async () => {
    const fake = fakeNotra();
    const later: Promise<void>[] = [];
    const agent = notra.create(TOKEN, ALL, { fetch: fake.fetch, waitUntil: (w) => later.push(w) });
    expect(await agent.thread()).toEqual([]);

    await agent.send("What changed this week?", "client_1");
    expect(fake.calls.at(-1)).toEqual({
      method: "POST",
      path: "/v1/chats",
      body: {
        message: "What changed this week?",
        externalChannelId: { source: "dashboard", id: "nibblets" },
      },
    });
    // The reply streams back, and is read to the end after answering.
    expect(later).toHaveLength(1);
    await Promise.all(later);

    fake.reply(said("a1", "assistant", "Three posts shipped.", NOW + 1000));
    await agent.send("Which?", "client_2");
    expect(fake.calls.at(-1)).toMatchObject({
      path: "/v1/chats/chat_2",
      body: { message: "Which?" },
    });
    const thread = await agent.thread();
    expect(thread.map((m) => ThirdPartyMessage.parse(m))).toEqual([
      {
        id: "u1",
        role: "person",
        text: "What changed this week?",
        at: new Date(NOW).toISOString(),
      },
      {
        id: "a1",
        role: "agent",
        text: "Three posts shipped.",
        at: new Date(NOW + 1000).toISOString(),
      },
      { id: "u2", role: "person", text: "Which?", at: new Date(NOW).toISOString() },
    ]);
  });

  it("reads a long reply to the end, timing only how long it takes to start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeNotra();
    const signals: AbortSignal[] = [];
    let start = true;
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (init?.method === "POST" && init.signal) signals.push(init.signal);
      // Notra taking its time to start answering, until the request gives up on it.
      if (init?.method === "POST" && !start) {
        return new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
      }
      return fake.fetch(input, init);
    };
    const later: Promise<void>[] = [];
    const agent = notra.create(TOKEN, ALL, { fetch, waitUntil: (w) => later.push(w) });

    await agent.send("Write me a long post", "client_1");
    vi.advanceTimersByTime(60_000);
    expect(signals[0]?.aborted).toBe(false);

    start = false;
    const sending = agent.send("And another", "client_2");
    const failed = expect(sending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("doesn't send a message again when it's retried while Notra answers it", async () => {
    const fake = fakeNotra();
    const agent = notra.create(TOKEN, ALL, { fetch: fake.fetch });
    await agent.send("Hello", "c1");
    const posts = () => fake.calls.filter((c) => c.method === "POST").length;
    expect(posts()).toBe(1);
    // Notra counts as still answering while the message is recent.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW + 5000 });
    await agent.send("Hello", "c1");
    expect(posts()).toBe(1);
    // Long after, it's a message Notra never answered, so sending it again is meant.
    vi.setSystemTime(NOW + 3_600_000);
    await agent.send("Hello", "c1");
    expect(posts()).toBe(2);
  });

  it("makes the tools a reply waits on one request, answered all together", async () => {
    const fake = fakeNotra();
    const agent = notra.create(TOKEN, ALL, { fetch: fake.fetch });
    await agent.send("Write the changelog", "c1");
    fake.reply(
      asking([
        { name: "update_post", id: "ap_1", input: { postId: "post_1", status: "published" } },
        { name: "createSchedule", id: "ap_2", input: { cadence: "weekly", days: [1, 3] } },
      ]),
    );
    const [request, ...rest] = (await agent.requests()).map((r) => ThirdPartyRequest.parse(r));
    expect(rest).toEqual([]);
    expect(request).toMatchObject({
      id: "m_ask",
      title: "2 actions to allow",
      body: "I've drafted the changelog.\n\n- Update post\n- Create schedule",
      details: [
        { label: "Update post: Post id", text: "post_1" },
        { label: "Update post: Status", text: "published" },
        { label: "Create schedule: Cadence", text: "weekly" },
        { label: "Create schedule: Days", text: "[\n  1,\n  3\n]" },
      ],
      actions: [
        { id: "approve", label: "Allow all", primary: true, effect: "ships" },
        { id: "deny", label: "Allow none", primary: false, input: { kind: "text" } },
      ],
    });

    await agent.act("m_ask", "deny", { text: "Not yet" });
    expect(fake.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/chats/chat_2",
      body: {
        approvals: [
          { id: "ap_1", approved: false, reason: "Not yet" },
          { id: "ap_2", approved: false, reason: "Not yet" },
        ],
      },
    });
    await expect(agent.act("m_old", "approve", {})).rejects.toThrow("already answered");
  });

  it("calls one tool by its name, and lists none without leave to answer", async () => {
    const fake = fakeNotra();
    await notra.create(TOKEN, ALL, { fetch: fake.fetch }).send("Publish it", "c1");
    fake.reply(asking([{ name: "publish_post", id: "ap_1", input: { postId: "post_1" } }]));
    const [request] = await notra
      .create(TOKEN, { ...ALL, decide: false }, { fetch: fake.fetch })
      .requests();
    expect(request).toMatchObject({ title: "Publish post", actions: [] });

    const agent = notra.create(TOKEN, ALL, { fetch: fake.fetch });
    await agent.act("m_ask", "approve", {});
    expect(fake.calls.at(-1)?.body).toEqual({ approvals: [{ id: "ap_1", approved: true }] });
  });

  it("says it's working while the person's message is fresh, and waiting on approvals", async () => {
    const chat = (messages: Ui[]) => ({
      chat: {
        chatId: "c",
        createdAt: "2026-10-27T08:00:00.000Z",
        updatedAt: "2026-10-27T08:00:00.000Z",
        externalChannelId: null,
      },
      messages,
    });
    expect(toActivity(null)).toEqual({ working: false, waiting: 0 });
    expect(toActivity(chat([said("u", "user", "Hi", NOW)]), NOW + 1000)).toEqual({
      working: true,
      waiting: 0,
    });
    // One that never got an answer doesn't count as working for ever.
    expect(toActivity(chat([said("u", "user", "Hi", NOW)]), NOW + 3_600_000).working).toBe(false);
    expect(toActivity(chat([asking([{ name: "a", id: "1", input: {} }])]), NOW).waiting).toBe(1);
  });

  it("marks a credential Notra stopped taking revoked, and says plainly what it refused", async () => {
    const fake = fakeNotra();
    const agent = notra.create(TOKEN, ALL, { fetch: fake.fetch });
    fake.revoke();
    await expect(agent.thread()).rejects.toThrow(ThirdPartyRevokedError);

    const forbidden = notra.create(TOKEN, ALL, {
      fetch: fakeNotra({ type: "apiKey" }, false).fetch,
    });
    await expect(forbidden.thread()).rejects.toThrow(ThirdPartyError);
    await expect(forbidden.thread()).rejects.toThrow("Connect it again with Full access");
  });
});
