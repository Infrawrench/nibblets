import {
  defineThirdParty,
  ThirdPartyError,
  ThirdPartyRevokedError,
  type ThirdPartyAgent,
  type ThirdPartyDeps,
} from "@nibblets/third-party";
import type {
  ThirdPartyAbilities,
  ThirdPartyAction,
  ThirdPartyAnswer,
  ThirdPartyMessage,
  ThirdPartyRequest,
} from "@nibblets/protocol";
import { z } from "zod";
import { REVNU_ICON } from "./logo.ts";

/**
 * Revnu (revnu.com), a growth agent that runs a business's outreach, ads,
 * and search and AI visibility, as a third party. Connecting signs in with
 * the OAuth its MCP server uses, which makes a personal `rvp_` token
 * labelled with Connect's name; Revnu's own Settings → Developers lists and
 * revokes it. That token is its own conversation with Revnu, and reads the
 * review queue, the cards Revnu waits on the person to approve, answer or
 * choose on.
 *
 * The routes are Revnu's JSON API (`https://revnu.com/api/v1`, described at
 * `https://revnu.com/openapi.json`). There's no SDK for it.
 */

export const REVNU_URL = "https://revnu.com";

/** Where the person deals with cards that can only be approved in Revnu's dashboard. */
const REVIEW_PAGE = `${REVNU_URL}/dashboard/review`;

const TIMEOUT_MS = 20_000;

/** What connecting asks for: chat, whether it's busy, and the review queue to answer. */
const SCOPES = ["agent:message", "results:read", "review:read", "review:write"] as const;

const Me = z.object({
  me: z.object({
    scopes: z.array(z.string()),
    account: z.object({ id: z.string(), name: z.string().nullable() }),
    inSetup: z.boolean(),
  }),
});

const Status = z.object({ status: z.object({ running: z.boolean() }) });

const Thread = z.object({
  items: z.array(
    z.object({
      role: z.enum(["user", "agent"]),
      requestId: z.string(),
      text: z.string(),
      at: z.number(),
    }),
  ),
});

const Verb = z.enum([
  "answer",
  "approve",
  "choose",
  "dismiss",
  "request_changes",
  "send",
  "snooze",
]);
type Verb = z.infer<typeof Verb>;

const Card = z.object({
  id: z.string(),
  kind: z.string(),
  sourceType: z.string().nullish(),
  title: z.string(),
  prompt: z.string(),
  summary: z.string().nullable(),
  detail: z.string().nullable(),
  priority: z.enum(["high", "normal", "low"]),
  options: z.array(z.object({ label: z.string(), value: z.string() })).nullable(),
  textInput: z.object({ placeholder: z.string().nullable(), required: z.boolean() }).nullable(),
  budgetChange: z
    .object({ currency: z.string(), monthlyCap: z.number(), previousMonthlyCap: z.number() })
    .nullable(),
  payload: z.record(z.string(), z.json()).nullable(),
  // A verb Revnu adds later is left out rather than failing the whole queue.
  actions: z.array(z.string()).transform((verbs) =>
    verbs.flatMap((v) => {
      const verb = Verb.safeParse(v);
      return verb.success ? [verb.data] : [];
    }),
  ),
  primaryLabel: z.string(),
  autoResolveAt: z.number().nullable(),
  createdAt: z.number(),
});
type Card = z.infer<typeof Card>;

const Review = z.object({ items: z.array(Card) });

const ErrorBody = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    requiredScope: z.string().optional(),
  })
  .loose();

/** Which `approve`s send, publish or spend, as Revnu's answer docs list them. */
const APPROVE_SHIPS = new Set([
  "blog_draft",
  "blog_edit",
  "reddit_comment",
  "ads_launch",
  "ads_budget",
  "outbound_setup",
]);

/** The verb the dashboard's main button stands for, in the order Revnu picks it. */
const PRIMARY: readonly Verb[] = ["send", "approve", "choose", "answer"];

const SNOOZE_MS = 24 * 60 * 60_000;

/** What each scope lets Connect do, to say plainly when one wasn't allowed. */
const SCOPE_WORDS: Record<string, string> = {
  "agent:message": "message Revnu",
  "results:read": "see whether Revnu is working",
  "review:read": "see what Revnu is waiting on",
  "review:write": "answer Revnu's cards",
};

function abilities(scopes: readonly string[]): ThirdPartyAbilities {
  return {
    chat: scopes.includes("agent:message"),
    status: scopes.includes("results:read"),
    requests: scopes.includes("review:read"),
    decide: scopes.includes("review:write"),
  };
}

/** "Sending inboxes" from `sendingInboxes` or `sending_inboxes`. */
function labelFor(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** One of a card's verbs as an action, or null for one this card can't take here. */
function action(card: Card, verb: Verb, primary: Verb | null): ThirdPartyAction | null {
  const main = verb === primary;
  const label = (fallback: string) => (main ? card.primaryLabel : fallback);
  switch (verb) {
    case "send":
      return {
        id: verb,
        label: label("Send"),
        primary: main,
        effect: "ships",
        input: { kind: "none" },
      };
    case "approve":
      return {
        id: verb,
        label: label("Approve"),
        primary: main,
        effect: card.sourceType && APPROVE_SHIPS.has(card.sourceType) ? "ships" : "answers",
        input: { kind: "none" },
      };
    case "choose":
      return card.options?.length
        ? {
            id: verb,
            label: label("Choose"),
            primary: main,
            effect: "answers",
            input: { kind: "choice", options: card.options },
          }
        : null;
    case "answer":
      return {
        id: verb,
        label: label("Answer"),
        primary: main,
        effect: "answers",
        input: card.textInput
          ? {
              kind: "text",
              required: card.textInput.required,
              placeholder: card.textInput.placeholder,
            }
          : { kind: "none" },
      };
    case "request_changes":
      return {
        id: verb,
        label: "Request changes",
        primary: false,
        effect: "none",
        input: { kind: "text", required: true, placeholder: "What should change?" },
      };
    case "snooze":
      return {
        id: verb,
        label: "Snooze a day",
        primary: false,
        effect: "none",
        input: { kind: "none" },
      };
    case "dismiss":
      return {
        id: verb,
        label: "Dismiss",
        primary: false,
        effect: "none",
        input: { kind: "text", required: false, placeholder: "Why? (optional)" },
      };
  }
}

/** A card as a request: its words, what it carries, and the verbs it takes now. */
export function toRequest(card: Card, decide: boolean): ThirdPartyRequest {
  const primary = PRIMARY.find((v) => card.actions.includes(v)) ?? null;
  const actions = decide
    ? card.actions.flatMap((verb) => {
        const made = action(card, verb, primary);
        return made ? [made] : [];
      })
    : [];
  const budget = card.budgetChange
    ? `Monthly ad budget: ${money(card.budgetChange.previousMonthlyCap, card.budgetChange.currency)} → ${money(card.budgetChange.monthlyCap, card.budgetChange.currency)}`
    : null;
  const body = [card.prompt !== card.title ? card.prompt : null, card.summary, card.detail, budget]
    .filter((part): part is string => !!part?.trim())
    .join("\n\n");
  const details = Object.entries(card.payload ?? {}).flatMap(([key, value]) =>
    typeof value === "string" && value.trim() ? [{ label: labelFor(key), text: value }] : [],
  );
  // Without a main button here (LinkedIn and gift cards, or no `review:write`), Revnu's own does it.
  const mainHere = actions.some((a) => a.primary);
  return {
    id: card.id,
    title: card.title,
    body: body || null,
    details,
    priority: card.priority,
    createdAt: new Date(card.createdAt).toISOString(),
    goesAheadAt: card.autoResolveAt ? new Date(card.autoResolveAt).toISOString() : null,
    actions,
    open: {
      url: REVIEW_PAGE,
      label: mainHere ? "Open in Revnu" : `${card.primaryLabel} in Revnu`,
    },
  };
}

/** The conversation as Revnu lists it (newest first), oldest first. */
export function toMessages(thread: z.infer<typeof Thread>): ThirdPartyMessage[] {
  return thread.items
    .map((item, i) => ({
      // A request has the person's message and any number of replies, so its id alone isn't one.
      id: `${item.requestId}:${item.role}:${item.at}:${i}`,
      role: item.role === "user" ? ("person" as const) : ("agent" as const),
      text: item.text,
      at: new Date(item.at).toISOString(),
    }))
    .reverse();
}

/** Calls Revnu's API with a token, turning its refusals into errors fit to show. */
function revnuApi(token: string, deps: ThirdPartyDeps) {
  return async function call(method: string, path: string, body?: object): Promise<unknown> {
    const res = await deps.fetch(`${REVNU_URL}/api/v1${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed: unknown = await res.json().catch(() => null);
    if (res.ok) return parsed;
    const error = ErrorBody.safeParse(parsed);
    const said = error.success ? (error.data.message ?? error.data.error) : `HTTP ${res.status}`;
    switch (res.status) {
      case 401:
        throw new ThirdPartyRevokedError(
          "Revnu no longer takes this connection. Connect it again in Settings.",
        );
      case 402:
        throw new ThirdPartyError("Finish setting up Revnu on revnu.com first.");
      case 403: {
        const scope = error.success ? error.data.requiredScope : undefined;
        const what = (scope && SCOPE_WORDS[scope]) ?? "do that";
        throw new ThirdPartyError(
          `This connection wasn't allowed to ${what}. Connect Revnu again and tick it.`,
        );
      }
      case 429: {
        const wait = res.headers.get("retry-after");
        throw new ThirdPartyError(
          `Revnu asked to slow down. Try again in ${wait ? `${wait} seconds` : "a moment"}.`,
        );
      }
      case 400:
      case 404:
      case 409:
        // Revnu writes these for people: "This was already handled."
        throw new ThirdPartyError(`Revnu: ${said}`);
      default:
        throw new Error(`Revnu answered ${res.status} to ${method} ${path}`);
    }
  };
}

function revnuAgent(
  token: string,
  can: ThirdPartyAbilities,
  deps: ThirdPartyDeps,
): ThirdPartyAgent {
  const call = revnuApi(token, deps);

  const cards = async () => Review.parse(await call("GET", "/review?limit=100")).items;

  return {
    async activity() {
      const [running, waiting] = await Promise.all([
        can.status
          ? call("GET", "/agent/status").then((s) => Status.parse(s).status.running)
          : false,
        can.requests ? cards().then((items) => items.length) : 0,
      ]);
      return { working: running, waiting };
    },

    async thread() {
      return toMessages(Thread.parse(await call("GET", "/agent/thread?limit=100")));
    },

    async send(text, clientId) {
      // Queued, not interrupting: a message from here never stops work Revnu is in the middle of.
      await call("POST", "/agent/messages", { text, clientRequestId: clientId, queue: true });
    },

    async requests() {
      return (await cards()).map((card) => toRequest(card, can.decide));
    },

    async act(requestId, actionId, answer) {
      const verb = Verb.safeParse(actionId);
      if (!verb.success) throw new ThirdPartyError("Revnu doesn't know that action");
      const card = `/review/${encodeURIComponent(requestId)}`;
      await call("POST", ...route(card, verb.data, answer));
    },
  };
}

/** The route and body for a verb, as Revnu's review screen guide maps them. */
export function route(card: string, verb: Verb, answer: ThirdPartyAnswer): [string, object] {
  const text = answer.text?.trim() || undefined;
  switch (verb) {
    case "approve":
      return [`${card}/answer`, { action: verb, ...(text ? { text } : {}) }];
    case "answer":
      return [`${card}/answer`, { action: verb, ...(text ? { text } : {}) }];
    case "choose":
      if (!answer.option) throw new ThirdPartyError("Choose one first");
      return [`${card}/answer`, { action: verb, optionValues: [answer.option] }];
    case "send":
      return [`${card}/send`, {}];
    case "request_changes":
      if (!text) throw new ThirdPartyError("Say what should change");
      return [`${card}/request-changes`, { text }];
    case "snooze":
      return [`${card}/snooze`, { until: Date.now() + SNOOZE_MS }];
    case "dismiss":
      return [`${card}/dismiss`, text ? { reason: text.slice(0, 2000) } : {}];
  }
}

export const revnu = defineThirdParty({
  id: "revnu",
  name: "Revnu",
  description:
    "A growth agent that runs your outreach, ads, and search and AI visibility. Talk to it and approve its work here.",
  icon: REVNU_ICON,
  signIn: { issuer: REVNU_URL, resource: `${REVNU_URL}/api/mcp`, scopes: SCOPES },
  token: {
    label: "API token",
    placeholder: "rvp_…",
    hint: "Make one in Revnu under Settings → Developers, ticking agent:message, results:read, review:read and review:write.",
  },
  async identify(credential, deps) {
    const { me } = Me.parse(await revnuApi(credential, deps)("GET", "/me"));
    const can = abilities(me.scopes);
    if (!can.chat && !can.requests) {
      throw new ThirdPartyError(
        "That connection can't message Revnu or see its cards. Allow agent:message or review:read.",
      );
    }
    return { ref: me.account.id, account: me.account.name ?? "Revnu", abilities: can };
  },
  create: (credential, can, deps) => revnuAgent(credential, can, deps),
});
