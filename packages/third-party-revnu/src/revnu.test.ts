import { ThirdPartyError, ThirdPartyRevokedError } from "@nibblets/third-party";
import { ThirdPartyRequest, type ThirdPartyAbilities } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { revnu, REVNU_URL } from "./index.ts";

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, string | number | boolean | string[]> | null;
}

const TOKEN = "rvp_test";

const card = (more: Record<string, string | number | boolean | null | object> = {}) => ({
  id: "k1",
  kind: "approval",
  sourceType: "gmail_draft",
  status: "pending",
  title: "Reply to Priya at Acme",
  prompt: "Reply to Priya at Acme",
  summary: "She asked about pricing.",
  detail: null,
  priority: "high",
  options: null,
  textInput: null,
  budgetChange: null,
  payload: { subject: "Re: pricing", body: "Thanks Priya…", research: { size: 50 }, empty: " " },
  actions: ["send", "request_changes", "snooze", "dismiss"],
  primaryLabel: "Send Reply",
  autoResolveAt: 1_789_900_000_000,
  dueAt: null,
  snoozedUntil: null,
  leadId: "l1",
  leadContactId: null,
  postId: null,
  createdAt: 1_789_800_000_000,
  updatedAt: 1_789_800_000_000,
  resolvedAt: null,
  ...more,
});

/** A Revnu that answers as its API docs say, for one token with the scopes given. */
function fakeRevnu(
  scopes: string[] = ["agent:message", "results:read", "review:read", "review:write"],
) {
  const calls: Call[] = [];
  let revoked = false;
  const replies = new Map<string, Response>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    calls.push({
      method: request.method,
      path: url.pathname + url.search,
      auth: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : null,
    });
    if (revoked || request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const canned = replies.get(`${request.method} ${url.pathname}`);
    if (canned) return canned.clone();
    const need = (scope: string) =>
      scopes.includes(scope)
        ? null
        : Response.json({ error: "forbidden", requiredScope: scope }, { status: 403 });
    switch (`${request.method} ${url.pathname}`) {
      case "GET /api/v1/me":
        return Response.json({
          me: {
            tokenId: "t1",
            label: "Nibblets",
            scopes,
            createdAt: 1,
            lastUsedAt: null,
            account: { id: "acc_1", name: "Acme" },
            inSetup: false,
            limits: {},
          },
        });
      case "GET /api/v1/agent/status":
        return (
          need("results:read") ?? Response.json({ status: { sandbox: "alive", running: true } })
        );
      case "GET /api/v1/agent/thread":
        return (
          need("agent:message") ??
          Response.json({
            items: [
              { role: "agent", requestId: "r1", text: "Three replied.", at: 1_789_800_002_000 },
              { role: "agent", requestId: "r1", text: "Looking…", at: 1_789_800_001_000 },
              { role: "user", requestId: "r1", text: "Who replied?", at: 1_789_800_000_000 },
            ],
          })
        );
      case "POST /api/v1/agent/messages":
        return (
          need("agent:message") ??
          Response.json({ requestId: "r2", deduplicated: false }, { status: 202 })
        );
      case "GET /api/v1/review":
        return (
          need("review:read") ??
          Response.json({
            items: [
              card(),
              card({
                id: "k2",
                sourceType: "linkedin_invite",
                title: "Connect with Sam",
                actions: ["snooze", "dismiss"],
                primaryLabel: "Send Invite",
                payload: null,
                autoResolveAt: null,
              }),
              card({
                id: "k3",
                kind: "choice",
                sourceType: "agent",
                title: "Which market next?",
                prompt: "Pick where to look next.",
                options: [
                  { label: "UK", value: "uk" },
                  { label: "Germany", value: "de" },
                ],
                actions: ["choose", "answer", "teleport", "dismiss"],
                textInput: { placeholder: "Or say", required: false },
                primaryLabel: "Choose",
                payload: null,
              }),
              card({
                id: "k4",
                sourceType: "ads_budget",
                title: "Raise the ad budget",
                budgetChange: { currency: "GBP", monthlyCap: 900, previousMonthlyCap: 500 },
                actions: ["approve", "dismiss"],
                primaryLabel: "Raise Budget",
                payload: null,
              }),
            ],
          })
        );
    }
    const act = /^\/api\/v1\/review\/([^/]+)\/(answer|send|request-changes|snooze|dismiss)$/.exec(
      url.pathname,
    );
    if (act && request.method === "POST")
      return need("review:write") ?? Response.json({ ok: true });
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return {
    fetch,
    calls,
    revoke: () => {
      revoked = true;
    },
    reply: (route: string, response: Response) => replies.set(route, response),
  };
}

const ALL: ThirdPartyAbilities = { chat: true, status: true, requests: true, decide: true };

describe("Revnu", () => {
  it("says who a token is and what it may do, from its scopes", async () => {
    const revnuApi = fakeRevnu(["agent:message", "review:read"]);
    const who = await revnu.identify(TOKEN, revnuApi);
    expect(who).toEqual({
      ref: "acc_1",
      account: "Acme",
      abilities: { chat: true, status: false, requests: true, decide: false },
    });
    expect(revnuApi.calls[0]).toMatchObject({ path: "/api/v1/me", auth: `Bearer ${TOKEN}` });
  });

  it("won't take a token that can neither chat nor see cards", async () => {
    await expect(revnu.identify(TOKEN, fakeRevnu(["results:read"]))).rejects.toThrow(
      ThirdPartyError,
    );
  });

  it("calls a token Revnu doesn't know revoked", async () => {
    await expect(revnu.identify("rvp_wrong", fakeRevnu())).rejects.toThrow(ThirdPartyRevokedError);
  });

  it("says whether it's working and how much is waiting, asking only what it may", async () => {
    const all = fakeRevnu();
    expect(await revnu.create(TOKEN, ALL, all).activity()).toEqual({ working: true, waiting: 4 });

    const chatOnly = fakeRevnu(["agent:message"]);
    const agent = revnu.create(
      TOKEN,
      { chat: true, status: false, requests: false, decide: false },
      chatOnly,
    );
    expect(await agent.activity()).toEqual({ working: false, waiting: 0 });
    expect(chatOnly.calls).toEqual([]);
  });

  it("gives the conversation oldest first, with ids that tell replies apart", async () => {
    const messages = await revnu.create(TOKEN, ALL, fakeRevnu()).thread();
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["person", "Who replied?"],
      ["agent", "Looking…"],
      ["agent", "Three replied."],
    ]);
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
    expect(messages[0]?.at).toBe(new Date(1_789_800_000_000).toISOString());
  });

  it("queues a message rather than interrupting, with the client id for safe retries", async () => {
    const revnuApi = fakeRevnu();
    await revnu.create(TOKEN, ALL, revnuApi).send("Find UK fintechs", "nib-123456");
    expect(revnuApi.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v1/agent/messages",
      body: { text: "Find UK fintechs", clientRequestId: "nib-123456", queue: true },
    });
  });

  it("turns cards into requests driven by their actions, labelled honestly", async () => {
    const requests = await revnu.create(TOKEN, ALL, fakeRevnu()).requests();
    for (const r of requests) ThirdPartyRequest.parse(r);
    const [email, linkedin, choice, budget] = requests;

    // An email: its main button sends, and what it carries is shown as text.
    expect(email?.actions.map((a) => [a.id, a.label, a.primary, a.effect])).toEqual([
      ["send", "Send Reply", true, "ships"],
      ["request_changes", "Request changes", false, "none"],
      ["snooze", "Snooze a day", false, "none"],
      ["dismiss", "Dismiss", false, "none"],
    ]);
    expect(email?.details).toEqual([
      { label: "Subject", text: "Re: pricing" },
      { label: "Body", text: "Thanks Priya…" },
    ]);
    expect(email?.body).toBe("She asked about pricing.");
    expect(email?.goesAheadAt).toBe(new Date(1_789_900_000_000).toISOString());
    expect(email?.open?.label).toBe("Open in Revnu");

    // LinkedIn is approved in Revnu's dashboard only, so that's where its main button is.
    expect(linkedin?.actions.some((a) => a.primary)).toBe(false);
    expect(linkedin?.open).toEqual({
      url: `${REVNU_URL}/dashboard/review`,
      label: "Send Invite in Revnu",
    });

    // A choice offers its options; a verb Revnu adds later is left out.
    expect(choice?.body).toBe("Pick where to look next.\n\nShe asked about pricing.");
    expect(choice?.actions.map((a) => a.id)).toEqual(["choose", "answer", "dismiss"]);
    expect(choice?.actions[0]).toMatchObject({
      primary: true,
      input: {
        kind: "choice",
        options: [
          { label: "UK", value: "uk" },
          { label: "Germany", value: "de" },
        ],
      },
    });
    expect(choice?.actions[1]).toMatchObject({
      primary: false,
      effect: "answers",
      input: { kind: "text", required: false, placeholder: "Or say" },
    });

    // Raising the budget spends money.
    expect(budget?.actions[0]).toMatchObject({
      id: "approve",
      label: "Raise Budget",
      effect: "ships",
    });
    expect(budget?.body).toContain("£500.00 → £900.00");
  });

  it("offers no actions where it may only look", async () => {
    const requests = await revnu.create(TOKEN, { ...ALL, decide: false }, fakeRevnu()).requests();
    expect(requests.every((r) => r.actions.length === 0)).toBe(true);
    expect(requests[0]?.open?.label).toBe("Send Reply in Revnu");
  });

  it("takes each action on the route Revnu's guide maps it to", async () => {
    const revnuApi = fakeRevnu();
    const agent = revnu.create(TOKEN, ALL, revnuApi);
    await agent.act("k1", "send", {});
    await agent.act("k3", "choose", { option: "de" });
    await agent.act("k3", "answer", { text: "  Try France  " });
    await agent.act("k4", "approve", {});
    await agent.act("k1", "request_changes", { text: "Shorter" });
    await agent.act("k1", "dismiss", {});
    const before = Date.now();
    await agent.act("k1", "snooze", {});
    expect(revnuApi.calls.map((c) => [c.path, c.body])).toEqual([
      ["/api/v1/review/k1/send", {}],
      ["/api/v1/review/k3/answer", { action: "choose", optionValues: ["de"] }],
      ["/api/v1/review/k3/answer", { action: "answer", text: "Try France" }],
      ["/api/v1/review/k4/answer", { action: "approve" }],
      ["/api/v1/review/k1/request-changes", { text: "Shorter" }],
      ["/api/v1/review/k1/dismiss", {}],
      ["/api/v1/review/k1/snooze", { until: expect.any(Number) }],
    ]);
    const until = Number(revnuApi.calls.at(-1)?.body?.until);
    expect(until).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
  });

  it("refuses what it can't take before asking Revnu", async () => {
    const revnuApi = fakeRevnu();
    const agent = revnu.create(TOKEN, ALL, revnuApi);
    await expect(agent.act("k1", "teleport", {})).rejects.toThrow(ThirdPartyError);
    await expect(agent.act("k1", "request_changes", { text: " " })).rejects.toThrow(
      "Say what should change",
    );
    await expect(agent.act("k3", "choose", {})).rejects.toThrow("Choose one first");
    expect(revnuApi.calls).toEqual([]);
  });

  it("passes on Revnu's own words, and says plainly what a token wasn't allowed", async () => {
    const revnuApi = fakeRevnu(["agent:message", "review:read"]);
    const agent = revnu.create(TOKEN, ALL, revnuApi);
    await expect(agent.act("k1", "send", {})).rejects.toThrow(
      "This connection wasn't allowed to answer Revnu's cards. Connect Revnu again and tick it.",
    );
    revnuApi.reply(
      "POST /api/v1/review/k9/answer",
      Response.json({ error: "rejected", message: "This was already handled." }, { status: 409 }),
    );
    await expect(agent.act("k9", "approve", {})).rejects.toThrow(
      "Revnu: This was already handled.",
    );
    revnuApi.reply(
      "GET /api/v1/agent/thread",
      Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "12" } }),
    );
    await expect(agent.thread()).rejects.toThrow("Try again in 12 seconds");
  });

  it("hides Revnu's outages, which may say anything, behind a plain error", async () => {
    const revnuApi = fakeRevnu();
    revnuApi.reply(
      "GET /api/v1/agent/thread",
      Response.json({ error: "temporarily unavailable" }, { status: 503 }),
    );
    const failure = await revnu
      .create(TOKEN, ALL, revnuApi)
      .thread()
      .catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ThirdPartyError);
  });

  it("marks the connection revoked when Revnu stops taking it", async () => {
    const revnuApi = fakeRevnu();
    const agent = revnu.create(TOKEN, ALL, revnuApi);
    revnuApi.revoke();
    await expect(agent.requests()).rejects.toThrow(ThirdPartyRevokedError);
  });
});
