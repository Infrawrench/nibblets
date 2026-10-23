import { AppLinkError, AppLinkRevokedError, type LinkRef } from "@nibblets/app-link";
import { describe, expect, it } from "vitest";
import { infrawrench, infrawrenchPlugin, INFRAWRENCH_URL } from "./index.ts";

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

interface FakeAgent {
  id: string;
  externalId: string;
  label: string;
  scopes: string[];
  providers: string[];
  credential: string;
  revokedAt: string | null;
  createdAt: string;
}

const CEILING = ["resources:read", "resources:write", "secrets:read"];

/**
 * An Infrawrench that keeps its agent links in memory and answers as the
 * agent links contract says: the device flow, then the link's own routes
 * with its `iwl_` credential.
 */
function fakeInfrawrench() {
  const calls: Call[] = [];
  const requests = new Map<
    string,
    {
      userCode: string;
      status: "pending" | "approved" | "denied" | "collected";
      lastPoll: number;
    }
  >();
  const link = {
    id: "lnk-uuid-1",
    credential: "iwl_secret",
    revoked: false,
  };
  const agents: FakeAgent[] = [];
  let made = 0;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const info = () => ({
    id: link.id,
    organizationId: "org-uuid",
    organizationName: "Acme",
    platform: "nibblets",
    label: "Nibblets on PogAir-4",
    scopes: CEILING,
    effectiveScopes: CEILING,
    scopeGroups: [
      {
        title: "Infrastructure",
        scopes: [
          { value: "resources:read", label: "Resources (read)" },
          { value: "resources:write", label: "Resources (write)" },
        ],
      },
      { title: "Secrets", scopes: [{ value: "secrets:read", label: "Secrets (read)" }] },
    ],
    providers: [
      { id: "aws", displayName: "AWS" },
      { id: "hetzner", displayName: "Hetzner" },
    ],
    approvedBy: { email: "astrid@infrawrench.com" },
    createdAt: "2026-10-23T10:00:00.000Z",
  });
  const view = (a: FakeAgent) => ({
    id: a.id,
    externalId: a.externalId,
    label: a.label,
    scopes: a.scopes,
    providers: a.providers,
    credentialPrefix: a.credential.slice(0, 8),
    lastSeenAt: null,
    revokedAt: a.revokedAt,
    createdAt: a.createdAt,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get("authorization");
    const path = url.pathname;
    calls.push({ method, path, auth, body });

    if (method === "POST" && path === "/api/agent-links/requests") {
      if (body?.platform !== "nibblets" || typeof body.label !== "string") {
        return reply(400, { error: "Bad request" });
      }
      const deviceCode = `dc_${requests.size + 1}`;
      const userCode = `ABCD-EFG${requests.size + 1}`;
      requests.set(deviceCode, { userCode, status: "pending", lastPoll: 0 });
      return reply(201, {
        deviceCode,
        userCode,
        verificationUrl: `${INFRAWRENCH_URL}/link-agents`,
        verificationUrlComplete: `${INFRAWRENCH_URL}/link-agents?code=${userCode}`,
        expiresIn: 900,
        interval: 5,
      });
    }
    if (method === "POST" && path === "/api/agent-links/requests/token") {
      const request = requests.get(String(body?.deviceCode));
      if (!request || request.status === "collected") return reply(200, { status: "expired" });
      if (Date.now() - request.lastPoll < 50) return reply(429, { error: "slow_down" });
      request.lastPoll = Date.now();
      if (request.status !== "approved") return reply(200, { status: request.status });
      request.status = "collected";
      return reply(200, { status: "approved", credential: link.credential, link: info() });
    }

    // Everything else is the link's.
    if (auth !== `Bearer ${link.credential}` || link.revoked) {
      return reply(401, { error: "Unauthorized" });
    }
    if (method === "GET" && path === "/api/agent-link") return reply(200, info());
    if (method === "DELETE" && path === "/api/agent-link") {
      link.revoked = true;
      for (const a of agents) a.revokedAt ??= new Date().toISOString();
      return reply(200, { ok: true });
    }
    if (method === "GET" && path === "/api/agent-link/agents") {
      return reply(200, [...agents].reverse().map(view));
    }
    if (method === "POST" && path === "/api/agent-link/agents") {
      const scopes = (body?.scopes as string[] | undefined) ?? [];
      const live = agents.find((a) => a.externalId === body?.externalId && !a.revokedAt);
      if (live) return reply(409, { error: "Already exists", code: "exists", agentId: live.id });
      const outside = scopes.filter((s) => !CEILING.includes(s));
      if (outside.length > 0) {
        return reply(400, {
          error: "Scope not allowed",
          code: "scope_not_allowed",
          scopes: outside,
        });
      }
      made++;
      const agent: FakeAgent = {
        id: `agent-${made}`,
        externalId: String(body?.externalId),
        label: String(body?.label),
        scopes,
        providers: (body?.providers as string[] | undefined) ?? [],
        credential: `iwa_${made}`,
        revokedAt: null,
        createdAt: new Date().toISOString(),
      };
      agents.push(agent);
      return reply(201, { agent: view(agent), credential: agent.credential });
    }
    const one = /^\/api\/agent-link\/agents\/([^/]+)$/.exec(path);
    const agent = one ? agents.find((a) => a.id === decodeURIComponent(one[1] ?? "")) : undefined;
    if (one && (!agent || agent.revokedAt)) return reply(404, { error: "Not found" });
    if (agent && method === "PATCH") {
      const scopes = body?.scopes as string[] | undefined;
      if (scopes?.some((s) => !CEILING.includes(s))) {
        return reply(400, { error: "Scope not allowed", code: "scope_not_allowed", scopes });
      }
      if (scopes) agent.scopes = scopes;
      if (body?.providers) agent.providers = body.providers as string[];
      if (typeof body?.label === "string") agent.label = body.label;
      return reply(200, { agent: view(agent) });
    }
    if (agent && method === "DELETE") {
      agent.revokedAt = new Date().toISOString();
      return reply(200, { ok: true });
    }
    return reply(404, { error: "Not found" });
  };
  return {
    fetch,
    calls,
    agents,
    link,
    answer(userCode: string, status: "approved" | "denied") {
      for (const r of requests.values()) if (r.userCode === userCode) r.status = status;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function linked() {
  const app = fakeInfrawrench();
  const plugin = infrawrenchPlugin({ url: INFRAWRENCH_URL }, app);
  const start = await plugin.begin({ label: "Nibblets on PogAir-4" });
  app.answer(start.userCode, "approved");
  const poll = await plugin.poll(start);
  if (poll.status !== "linked") throw new Error(`not linked: ${poll.status}`);
  return { app, plugin, link: poll.link };
}

describe("linking Infrawrench", () => {
  it("starts the device flow, waits, and collects the link's credential once", async () => {
    const app = fakeInfrawrench();
    const plugin = infrawrenchPlugin({ url: `${INFRAWRENCH_URL}/` }, app);
    const start = await plugin.begin({
      label: "Nibblets on PogAir-4",
      requestedScopes: ["resources:read"],
    });
    expect(app.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/agent-links/requests",
      auth: null,
      body: {
        platform: "nibblets",
        label: "Nibblets on PogAir-4",
        requestedScopes: ["resources:read"],
      },
    });
    expect(start).toMatchObject({
      secret: "dc_1",
      userCode: "ABCD-EFG1",
      verificationUrl: "https://app.infrawrench.com/link-agents",
      verificationUrlComplete: "https://app.infrawrench.com/link-agents?code=ABCD-EFG1",
      interval: 5,
    });
    expect(start.expiresAt.getTime()).toBeGreaterThan(Date.now() + 890_000);

    expect(await plugin.poll(start)).toEqual({ status: "pending" });
    // Too soon after the last.
    expect(await plugin.poll(start)).toEqual({ status: "slow_down" });
    await sleep(60);
    app.answer(start.userCode, "approved");
    expect(await plugin.poll(start)).toEqual({
      status: "linked",
      link: { ref: "lnk-uuid-1", secret: "iwl_secret" },
      account: "Acme on Infrawrench",
    });
    await sleep(60);
    // Answered once; the code is spent.
    expect(await plugin.poll(start)).toEqual({ status: "expired" });
    expect(app.calls.at(-1)?.body).toEqual({ deviceCode: "dc_1" });
  });

  it("says when the person denied it", async () => {
    const app = fakeInfrawrench();
    const plugin = infrawrenchPlugin({ url: INFRAWRENCH_URL }, app);
    const start = await plugin.begin({ label: "Nibblets" });
    app.answer(start.userCode, "denied");
    expect(await plugin.poll(start)).toEqual({ status: "denied" });
  });

  it("describes what the link may grant", async () => {
    const { plugin, link, app } = await linked();
    expect(await plugin.describe(link)).toEqual({
      account: "Acme on Infrawrench",
      scopeGroups: [
        {
          title: "Infrastructure",
          scopes: [
            { value: "resources:read", label: "Resources (read)" },
            { value: "resources:write", label: "Resources (write)" },
          ],
        },
        { title: "Secrets", scopes: [{ value: "secrets:read", label: "Secrets (read)" }] },
      ],
      providers: [
        { id: "aws", name: "AWS" },
        { id: "hetzner", name: "Hetzner" },
      ],
      ceiling: CEILING,
    });
    expect(app.calls.at(-1)).toMatchObject({
      method: "GET",
      path: "/api/agent-link",
      auth: "Bearer iwl_secret",
    });
  });
});

describe("a nibblet's agent", () => {
  it("is made, changed, inspected and revoked over the link's routes", async () => {
    const { app, plugin, link } = await linked();
    const grant = await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: ["aws"],
    });
    expect(grant).toEqual({
      ref: "agent-1",
      secret: "iwa_1",
      scopes: ["resources:read"],
      providers: ["aws"],
    });
    expect(app.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/agent-link/agents",
      auth: "Bearer iwl_secret",
      body: { externalId: "nib_1", label: "Pip", scopes: ["resources:read"], providers: ["aws"] },
    });

    expect(
      await plugin.update(link, grant, { scopes: ["resources:read", "secrets:read"] }),
    ).toEqual({ scopes: ["resources:read", "secrets:read"], providers: ["aws"] });
    expect(app.calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/api/agent-link/agents/agent-1",
    });

    expect(await plugin.inspect(link)).toEqual({ account: "Acme on Infrawrench", revoked: [] });

    await plugin.revoke(link, grant);
    expect(app.agents[0]?.revokedAt).not.toBeNull();
    // Again is fine.
    await plugin.revoke(link, grant);
    expect(await plugin.inspect(link)).toEqual({
      account: "Acme on Infrawrench",
      revoked: ["agent-1"],
    });
  });

  it("leaves providers out when it's for all of them", async () => {
    const { app, plugin, link } = await linked();
    await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: [],
    });
    expect(app.calls.at(-1)?.body).not.toHaveProperty("providers");
  });

  it("says which scopes the link can't grant", async () => {
    const { plugin, link } = await linked();
    const asked = plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read", "team:invite"],
      providers: [],
    });
    await expect(asked).rejects.toThrow(AppLinkError);
    await expect(asked).rejects.toThrow("This link can't grant team:invite");
  });

  it("revokes an agent it lost track of to make a new one for the same nibblet", async () => {
    const { app, plugin, link } = await linked();
    await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: [],
    });
    const again = await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: [],
    });
    expect(again.ref).toBe("agent-2");
    expect(app.agents.map((a) => a.revokedAt !== null)).toEqual([true, false]);
  });

  it("takes a 404 on an agent to mean Infrawrench revoked it", async () => {
    const { app, plugin, link } = await linked();
    const grant = await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: [],
    });
    const agent = app.agents[0];
    if (agent) agent.revokedAt = new Date().toISOString();
    const update = plugin.update(link, grant, { scopes: ["secrets:read"] });
    await expect(update).rejects.toBeInstanceOf(AppLinkRevokedError);
    await expect(update).rejects.toMatchObject({ what: "grant" });
  });

  it("connects through Infrawrench's MCP server with the agent's own credential", () => {
    const plugin = infrawrenchPlugin({ url: "https://iw.example.com/" }, { fetch });
    const connection = plugin.connection({ ref: "agent-1", secret: "iwa_1" });
    expect(connection.mcp).toEqual({
      url: "https://iw.example.com/api/mcp",
      headers: { authorization: "Bearer iwa_1" },
    });
    expect(connection.prompt).toContain("Infrawrench");
  });
});

describe("a revoked link", () => {
  it("answers 401 on every route, which reads as the link revoked", async () => {
    const { app, plugin, link } = await linked();
    app.link.revoked = true;
    for (const attempt of [
      plugin.describe(link),
      plugin.inspect(link),
      plugin.grant(link, { externalId: "nib_1", label: "Pip", scopes: [], providers: [] }),
      plugin.update(link, { ref: "agent-1" }, { scopes: [] }),
      plugin.revoke(link, { ref: "agent-1" }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ name: "AppLinkRevokedError", what: "link" });
    }
    // Unlinking what's already unlinked is done.
    await plugin.unlink(link);
  });

  it("is what unlinking makes, agents and all", async () => {
    const { app, plugin, link } = await linked();
    await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["resources:read"],
      providers: [],
    });
    await plugin.unlink(link);
    expect(app.link.revoked).toBe(true);
    expect(app.agents.every((a) => a.revokedAt !== null)).toBe(true);
    const wrong: LinkRef = { ref: link.ref, secret: "iwl_other" };
    await expect(plugin.describe(wrong)).rejects.toBeInstanceOf(AppLinkRevokedError);
  });
});

describe("the factory", () => {
  it("defaults to Infrawrench's own address, and takes only https elsewhere", () => {
    const deps = { fetch };
    expect(() => infrawrench.create({}, deps)).not.toThrow();
    expect(() => infrawrench.create({ url: "https://iw.internal.example" }, deps)).not.toThrow();
    expect(() => infrawrench.create({ url: "http://localhost:3000" }, deps)).not.toThrow();
    expect(() => infrawrench.create({ url: "http://iw.example.com" }, deps)).toThrow(
      "should be an https URL",
    );
    expect(() => infrawrench.create({ url: "not a url" }, deps)).toThrow("isn't a URL");
    expect(infrawrench.icon).toMatch(/^data:image\/png;base64,/);
  });

  it("calls a self-hosted Infrawrench where it's told to", async () => {
    const calls: string[] = [];
    const plugin = infrawrench.create(
      { url: "https://iw.internal.example/" },
      {
        fetch: async (input) => {
          calls.push(String(input));
          return Response.json({ status: "pending" });
        },
      },
    );
    await plugin.poll({
      secret: "dc",
      userCode: "X",
      verificationUrl: "",
      verificationUrlComplete: null,
      expiresAt: new Date(),
      interval: 5,
    });
    expect(calls).toEqual(["https://iw.internal.example/api/agent-links/requests/token"]);
  });

  it("treats a server error as not knowing what happened", async () => {
    const plugin = infrawrenchPlugin(
      { url: INFRAWRENCH_URL },
      { fetch: async () => new Response("oops", { status: 502 }) },
    );
    const asked = plugin.describe({ ref: "l", secret: "iwl_x" });
    await expect(asked).rejects.toThrow("HTTP 502");
    await expect(asked).rejects.not.toBeInstanceOf(AppLinkError);
  });
});
