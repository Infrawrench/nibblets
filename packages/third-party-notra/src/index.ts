import {
  defineThirdParty,
  ThirdPartyError,
  ThirdPartyRevokedError,
  type ThirdPartyAgent,
  type ThirdPartyDeps,
} from "@nibblets/third-party";
import type {
  ThirdPartyAbilities,
  ThirdPartyActivity,
  ThirdPartyMessage,
  ThirdPartyRequest,
} from "@nibblets/protocol";
import { z } from "zod";
import { NOTRA_ICON } from "./logo.ts";

/**
 * Notra (usenotra.com), an agent that tracks how AI answer engines talk
 * about a brand and writes its content, as a third party. Connecting signs
 * in with the OAuth its MCP server uses, choosing a workspace and an access
 * level, or takes an `ntra_` API key. Its access tokens last minutes, so
 * signing in asks for `offline_access` and Connect renews them.
 *
 * The conversation is a Notra chat of Nibblets' own, one per workspace,
 * tagged with an external channel id so it's found again; the dashboard
 * lists it beside the others. What Notra waits on is the tools it asks
 * leave to run (publishing a post, say), and Notra takes the answers to a
 * reply's approvals all at once, so they're one request.
 *
 * The routes are Notra's REST API (`https://api.usenotra.com`, described at
 * `https://api.usenotra.com/openapi.json`). Chats come back as the AI SDK's
 * UI messages, which the API doesn't describe further, so they're read
 * leniently.
 */

export const NOTRA_API = "https://api.usenotra.com";

const NOTRA_APP = "https://app.usenotra.com";

/** What tags Nibblets' chat in a workspace. */
const CHANNEL = { source: "dashboard", id: "nibblets" };

const TIMEOUT_MS = 20_000;

/**
 * How long after the person's message Notra still counts as answering it.
 * A reply that failed leaves the message unanswered, and that shouldn't
 * read as working for ever.
 */
const ANSWERING_MS = 10 * 60_000;

const Workspaces = z.object({
  currentWorkspace: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  authentication: z.object({ type: z.string(), scopes: z.array(z.string()).optional() }),
});

const Channel = z.object({ source: z.string(), id: z.string().optional() }).nullish();

const ChatSummary = z.object({
  chatId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  externalChannelId: Channel,
});
type ChatSummary = z.infer<typeof ChatSummary>;

const Chats = z.object({ chats: z.array(ChatSummary) });

const Moment = z.union([z.string(), z.number()]).nullish();

/** A part of an AI SDK UI message: text, or a tool call (`tool-<name>`, or `dynamic-tool`). */
const Part = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    state: z.string().optional(),
    toolName: z.string().optional(),
    input: z.json().optional(),
    approval: z.object({ id: z.string() }).loose().nullish(),
  })
  .loose();
type Part = z.infer<typeof Part>;

const Message = z
  .object({
    id: z.string(),
    role: z.string(),
    parts: z.array(Part).optional(),
    content: z.string().optional(),
    createdAt: Moment,
    metadata: z.object({ createdAt: Moment }).loose().nullish(),
  })
  .loose();
type Message = z.infer<typeof Message>;

const Chat = z.object({ chat: ChatSummary, messages: z.array(Message) });
type Chat = z.infer<typeof Chat>;

const ErrorBody = z.object({ error: z.string() }).loose();

/** Turned away for want of a scope: Notra's 403, which `identify` asks about on purpose. */
class NotraForbiddenError extends ThirdPartyError {
  constructor() {
    super("This connection isn't allowed to do that in Notra. Connect it again with Full access.");
    this.name = "NotraForbiddenError";
  }
}

/** What an OAuth connection may do, from the scopes Notra signed into it. */
function scopesAllow(scopes: readonly string[]): { read: boolean; write: boolean } {
  // Keys from before granular scopes carry `api.read` or `api.write`.
  return {
    read: scopes.some((s) => ["chats.read", "api.read", "api.write"].includes(s)),
    write: scopes.some((s) => ["chats.write", "api.write"].includes(s)),
  };
}

function abilities(read: boolean, write: boolean): ThirdPartyAbilities {
  return { chat: read && write, status: read, requests: read, decide: write };
}

/** "Update post" from `tool-update_post`, `updatePost` or `update-post`. */
function labelFor(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toolName(part: Part): string {
  return part.toolName ?? part.type.replace(/^tool-/, "");
}

/** A moment as an ISO timestamp, or `fallback` when it isn't one. */
function iso(moment: string | number | null | undefined, fallback: string): string {
  if (moment === null || moment === undefined) return fallback;
  const at = new Date(moment);
  return Number.isNaN(at.getTime()) ? fallback : at.toISOString();
}

function sentAt(message: Message, chat: ChatSummary): string {
  return iso(message.metadata?.createdAt ?? message.createdAt, iso(chat.updatedAt, chat.createdAt));
}

function textOf(message: Message): string {
  const parts = message.parts ?? [];
  const text = parts.flatMap((p) => (p.type === "text" && p.text?.trim() ? [p.text] : []));
  return text.length > 0 ? text.join("\n\n") : (message.content ?? "");
}

/** The tool calls in a message waiting on the person's say-so. */
function pending(message: Message): (Part & { approval: { id: string } })[] {
  return (message.parts ?? []).flatMap((part) =>
    part.state === "approval-requested" && part.approval
      ? [{ ...part, approval: part.approval }]
      : [],
  );
}

/** The conversation, without what isn't words (tool calls, reasoning, the system). */
export function toMessages(chat: Chat): ThirdPartyMessage[] {
  return chat.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textOf(message).trim();
    if (!text) return [];
    return [
      {
        id: message.id,
        role: message.role === "user" ? "person" : "agent",
        text,
        at: sentAt(message, chat.chat),
      },
    ];
  });
}

/** The latest reply's approvals as one request, or none when nothing's waiting. */
export function toRequests(chat: Chat, decide: boolean): ThirdPartyRequest[] {
  const last = chat.messages.at(-1);
  const tools = last?.role === "assistant" ? pending(last) : [];
  const [first] = tools;
  if (!last || !first) return [];
  const one = tools.length === 1;
  const details = tools.flatMap((tool) => {
    const prefix = one ? "" : `${labelFor(toolName(tool))}: `;
    const input = tool.input;
    if (input === undefined || input === null) return [];
    if (typeof input !== "object" || Array.isArray(input)) {
      return [{ label: `${prefix}Input`, text: JSON.stringify(input, null, 2) }];
    }
    return Object.entries(input).flatMap(([key, value]) => {
      if (value === null || value === "") return [];
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return [{ label: `${prefix}${labelFor(key)}`, text }];
    });
  });
  const said = textOf(last).trim();
  const names = tools.map((t) => `- ${labelFor(toolName(t))}`).join("\n");
  return [
    {
      id: last.id,
      title: one ? labelFor(toolName(first)) : `${tools.length} actions to allow`,
      body:
        [said || null, one ? "Notra waits for your go-ahead to do this." : names]
          .filter((part): part is string => !!part)
          .join("\n\n") || null,
      details,
      priority: "normal",
      createdAt: sentAt(last, chat.chat),
      goesAheadAt: null,
      actions: decide
        ? [
            {
              id: "approve",
              label: one ? "Allow" : "Allow all",
              primary: true,
              // What a tool does is up to Notra; the ones it asks about publish and change things.
              effect: "ships",
              input: { kind: "none" },
            },
            {
              id: "deny",
              label: one ? "Don't allow" : "Allow none",
              primary: false,
              effect: "answers",
              input: { kind: "text", required: false, placeholder: "Why not? (optional)" },
            },
          ]
        : [],
      open: { url: NOTRA_APP, label: "Open Notra" },
    },
  ];
}

/** Whether Notra is answering: the person spoke last, a moment ago, or a tool is running. */
export function toActivity(chat: Chat | null, now = Date.now()): ThirdPartyActivity {
  const last = chat?.messages.at(-1);
  if (!chat || !last) return { working: false, waiting: 0 };
  const recent = now - Date.parse(sentAt(last, chat.chat)) < ANSWERING_MS;
  const running = (last.parts ?? []).some(
    (p) =>
      p.state === "streaming" || p.state === "input-streaming" || p.state === "input-available",
  );
  return {
    working: recent && (last.role === "user" || running),
    // However many tools it asks about, they're answered together, so they're one thing.
    waiting: last.role === "assistant" && pending(last).length > 0 ? 1 : 0,
  };
}

/** Calls Notra's API with a credential, turning its refusals into errors fit to show. */
function notraApi(credential: string, deps: ThirdPartyDeps) {
  async function request(method: string, path: string, body?: object): Promise<Response> {
    const res = await deps.fetch(`${NOTRA_API}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return res;
    const error = ErrorBody.safeParse(await res.json().catch(() => null));
    const said = error.success ? error.data.error : `HTTP ${res.status}`;
    switch (res.status) {
      case 401:
        throw new ThirdPartyRevokedError(
          "Notra no longer takes this connection. Connect it again in Settings.",
        );
      case 402:
        throw new ThirdPartyError(
          "Notra needs an active plan or AI credits for that. Add them on usenotra.com.",
        );
      case 403:
        // "Forbidden" is a missing scope; anything else (a usage limit) Notra words itself.
        if (said === "Forbidden" || said.startsWith("Forbidden:")) throw new NotraForbiddenError();
        throw new ThirdPartyError(`Notra: ${said}`);
      case 409:
        throw new ThirdPartyError(
          "Notra is still answering, or what it's waiting on has changed. Try again in a moment.",
        );
      case 429: {
        const wait = res.headers.get("retry-after");
        throw new ThirdPartyError(
          `Notra asked to slow down. Try again in ${wait ? `${wait} seconds` : "a moment"}.`,
        );
      }
      case 400:
      case 404:
        throw new ThirdPartyError(`Notra: ${said}`);
      default:
        throw new Error(`Notra answered ${res.status} to ${method} ${path}`);
    }
  }

  return {
    request,
    async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
      return schema.parse(await (await request("GET", path)).json());
    },
    /**
     * Posts to a chat, which streams the reply back. Notra writes the reply
     * into the chat as it goes, so it's read to the end after the person
     * has their answer, rather than kept waiting for.
     */
    async post(path: string, body: object): Promise<void> {
      const res = await request("POST", path, body);
      const stream = res.body;
      if (!stream) return;
      if (!deps.waitUntil) {
        await stream.cancel();
        return;
      }
      deps.waitUntil(
        stream.pipeTo(new WritableStream()).catch((err: Error) => {
          console.warn(JSON.stringify({ message: "Notra's reply stopped", error: err.message }));
        }),
      );
    },
  };
}

function notraAgent(
  credential: string,
  can: ThirdPartyAbilities,
  deps: ThirdPartyDeps,
): ThirdPartyAgent {
  const api = notraApi(credential, deps);

  const ours = (chat: ChatSummary) =>
    chat.externalChannelId?.source === CHANNEL.source && chat.externalChannelId.id === CHANNEL.id;

  /** Nibblets' chat in the workspace, with its messages, or null before the first message. */
  async function chat(): Promise<Chat | null> {
    const found = (await api.read("/v1/chats", Chats)).chats.find(ours);
    return found ? api.read(`/v1/chats/${encodeURIComponent(found.chatId)}`, Chat) : null;
  }

  return {
    async activity() {
      return can.status || can.requests ? toActivity(await chat()) : { working: false, waiting: 0 };
    },

    async thread() {
      const current = await chat();
      return current ? toMessages(current) : [];
    },

    async send(text) {
      const current = await chat();
      if (!current) {
        await api.post("/v1/chats", { message: text, externalChannelId: CHANNEL });
        return;
      }
      // Notra has no idempotency key, so a send retried while it's answering the first is dropped.
      const last = current.messages.at(-1);
      if (last?.role === "user" && textOf(last).trim() === text.trim()) {
        if (toActivity(current).working) return;
      }
      await api.post(`/v1/chats/${encodeURIComponent(current.chat.chatId)}`, { message: text });
    },

    async requests() {
      const current = await chat();
      return current ? toRequests(current, can.decide) : [];
    },

    async act(requestId, actionId, answer) {
      if (actionId !== "approve" && actionId !== "deny") {
        throw new ThirdPartyError("Notra doesn't know that action");
      }
      const current = await chat();
      const last = current?.messages.at(-1);
      const tools = last && last.id === requestId ? pending(last) : [];
      if (!current || tools.length === 0) {
        throw new ThirdPartyError("Notra: That was already answered.");
      }
      const reason = answer.text?.trim().slice(0, 2000);
      await api.post(`/v1/chats/${encodeURIComponent(current.chat.chatId)}`, {
        approvals: tools.map((tool) => ({
          id: tool.approval.id,
          approved: actionId === "approve",
          ...(actionId === "deny" && reason ? { reason } : {}),
        })),
      });
    },
  };
}

export const notra = defineThirdParty({
  id: "notra",
  name: "Notra",
  description:
    "Tracks how ChatGPT, Claude and other AI engines talk about your brand, and writes the content to change it. Talk to it and allow what it does here.",
  icon: NOTRA_ICON,
  signIn: {
    issuer: "https://oauth.usenotra.com",
    resource: NOTRA_API,
    scopes: ["openid", "offline_access"],
  },
  token: {
    label: "API key",
    placeholder: "ntra_…",
    hint: "Make one in Notra under API Keys, at the bottom of the sidebar: Restricted, with Write on Chats.",
  },
  async identify(credential, deps) {
    const api = notraApi(credential, deps);
    const me = await api.read("/v1/me/workspaces", Workspaces);
    const scopes = me.authentication.scopes;
    let can: { read: boolean; write: boolean };
    if (scopes) {
      can = scopesAllow(scopes);
    } else {
      // An API key doesn't say what it may do, so ask; one that can't write is told when it tries.
      const read = await api.request("GET", "/v1/chats").then(
        () => true,
        (err: Error) => {
          if (err instanceof NotraForbiddenError) return false;
          throw err;
        },
      );
      can = { read, write: true };
    }
    if (!can.read) {
      throw new ThirdPartyError(
        "That connection can't read Notra's chats. Connect again with Full access, or a key with Write on Chats.",
      );
    }
    return {
      ref: me.currentWorkspace.id,
      account: me.currentWorkspace.name,
      abilities: abilities(can.read, can.write),
    };
  },
  create: (credential, can, deps) => notraAgent(credential, can, deps),
});
