import {
  AppLinkError,
  AppLinkRevokedError,
  defineAppLinkFactory,
  defineField,
  type AppLinkPlugin,
} from "@nibblets/app-link";
import type { LiveMessage } from "@nibblets/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppLinks,
  newLinkName,
  type AppGrantRow,
  type AppLinkRow,
  type AppLinkStore,
} from "./app-links.ts";
import { createHandlers, type Services } from "./handlers.ts";

/** An app that keeps its link and agents in memory, and can go down or revoke things. */
function fakeApp() {
  const app = {
    down: false,
    linkRevoked: false,
    answer: "pending" as "pending" | "approved" | "denied",
    agents: new Map<string, { externalId: string; scopes: string[]; revoked: boolean }>(),
    unlinked: 0,
    made: 0,
  };
  const reachable = (what = "link") => {
    if (app.down) throw new Error("connect ECONNREFUSED with secret iwl_x");
    if (app.linkRevoked && what === "link") {
      throw new AppLinkRevokedError("link", "Fake says this link was revoked");
    }
  };
  const plugin: AppLinkPlugin = {
    begin: async () => {
      reachable("start");
      return {
        secret: "device-code",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://fake.example/link",
        verificationUrlComplete: "https://fake.example/link?code=ABCD-EFGH",
        expiresAt: new Date(Date.now() + 900_000),
        interval: 5,
      };
    },
    poll: async () => {
      reachable("start");
      if (app.answer === "approved") {
        return { status: "linked", link: { ref: "app-link-1", secret: "iwl_x" }, account: "Acme" };
      }
      return { status: app.answer };
    },
    describe: async () => {
      reachable();
      return {
        account: "Acme",
        scopeGroups: [{ title: "All", scopes: [{ value: "read", label: "Read" }] }],
        providers: null,
        ceiling: ["read", "write"],
      };
    },
    grant: async (_link, request) => {
      reachable();
      if (request.scopes.includes("admin")) throw new AppLinkError("This link can't grant admin");
      app.made++;
      const ref = `agent-${app.made}`;
      app.agents.set(ref, {
        externalId: request.externalId,
        scopes: request.scopes,
        revoked: false,
      });
      return {
        ref,
        secret: `iwa_${app.made}`,
        scopes: request.scopes,
        providers: request.providers,
      };
    },
    update: async (_link, grant, request) => {
      reachable();
      const agent = app.agents.get(grant.ref);
      if (!agent || agent.revoked) throw new AppLinkRevokedError("grant", "Fake revoked it");
      if (request.scopes) agent.scopes = request.scopes;
      return { scopes: agent.scopes, providers: request.providers ?? [] };
    },
    revoke: async (_link, grant) => {
      reachable();
      const agent = app.agents.get(grant.ref);
      if (agent) agent.revoked = true;
    },
    unlink: async () => {
      if (app.down) throw new Error("down");
      app.unlinked++;
      for (const agent of app.agents.values()) agent.revoked = true;
    },
    inspect: async () => {
      reachable();
      return {
        account: "Acme Inc",
        revoked: [...app.agents].filter(([, a]) => a.revoked).map(([ref]) => ref),
      };
    },
    adopt: async (secret) => {
      reachable("start");
      if (secret !== "iwl_x" && secret !== "iwl_y") {
        throw new AppLinkError("Fake doesn't take that link's credential");
      }
      return { link: { ref: "app-link-1", secret }, account: "Acme" };
    },
    connection: (grant) => ({
      mcp: {
        url: "https://fake.example/mcp",
        headers: { authorization: `Bearer ${grant.secret}` },
      },
      prompt: "Fake's tools act as you.",
    }),
  };
  const factory = defineAppLinkFactory({
    id: "fake",
    name: "Fake",
    description: "An app for tests.",
    icon: "data:image/svg+xml,<svg/>",
    fields: [defineField("url", "Fake URL", { default: "https://fake.example" })],
    create: (settings) => {
      if (settings.url === "nope") throw new AppLinkError("Fake URL isn't a URL");
      return plugin;
    },
  });
  return { app, factory };
}

function memoryStore(): AppLinkStore & { links: AppLinkRow[]; grants: AppGrantRow[] } {
  const links: AppLinkRow[] = [];
  let grants: AppGrantRow[] = [];
  const nibblets = new Map([
    ["nib_1", { id: "nib_1", name: "Pip", parentId: null }],
    ["nib_2", { id: "nib_2", name: "Tuft", parentId: "nib_1" }],
  ]);
  return {
    links,
    get grants() {
      return grants;
    },
    appLinks: async () => links.map((l) => ({ ...l })),
    createAppLink: async (row) => {
      const made = { ...row, createdAt: new Date(), updatedAt: new Date() };
      links.push(made);
      return made;
    },
    updateAppLink: async (id, patch) => {
      const link = links.find((l) => l.id === id);
      if (link) Object.assign(link, patch, { updatedAt: new Date() });
    },
    deleteAppLink: async (id) => {
      const at = links.findIndex((l) => l.id === id);
      if (at >= 0) links.splice(at, 1);
      grants = grants.filter((g) => g.linkId !== id);
    },
    appGrants: async ({ nibbletId, linkId }) =>
      grants
        .filter(
          (g) =>
            (nibbletId === undefined || g.nibbletId === nibbletId) &&
            (linkId === undefined || g.linkId === linkId),
        )
        .map((g) => ({ ...g })),
    putAppGrant: async (row) => {
      grants = grants.filter((g) => !(g.nibbletId === row.nibbletId && g.linkId === row.linkId));
      grants.push({ ...row, createdAt: new Date(), updatedAt: new Date() });
    },
    updateAppGrant: async (nibbletId, linkId, patch) => {
      const grant = grants.find((g) => g.nibbletId === nibbletId && g.linkId === linkId);
      if (grant) Object.assign(grant, patch, { updatedAt: new Date() });
    },
    deleteAppGrant: async (nibbletId, linkId) => {
      grants = grants.filter((g) => !(g.nibbletId === nibbletId && g.linkId === linkId));
    },
    nibbletRow: async (id) => {
      const row = nibblets.get(id);
      if (!row) throw new Error(`No nibblet ${id}`);
      return row;
    },
  };
}

function setUp() {
  const { app, factory } = fakeApp();
  const store = memoryStore();
  const messages: LiveMessage[] = [];
  const reconfigured: string[] = [];
  const logs: string[] = [];
  const links = new AppLinks({
    store,
    factories: [factory],
    publish: (m) => messages.push(m),
    label: async () => "Nibblets on PogAir-4",
    reconfigure: async (id) => {
      reconfigured.push(id);
    },
    log: (m) => logs.push(m),
  });
  return { app, store, links, messages, reconfigured, logs };
}

/** Links through the device flow, with the clock run on. */
async function link(t: ReturnType<typeof setUp>): Promise<string> {
  const attempt = await t.links.begin("fake", {});
  t.app.answer = "approved";
  await vi.advanceTimersByTimeAsync(5_000);
  const settled = t.messages.find((m) => m.type === "app_link_settled");
  if (settled?.type !== "app_link_settled" || !settled.linkId) {
    throw new Error(`didn't link: ${JSON.stringify(settled)}`);
  }
  expect(settled.attemptId).toBe(attempt.id);
  return settled.linkId;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("linking an app", () => {
  it("shows the code, waits for the person, and keeps the link with its secret", async () => {
    vi.useFakeTimers();
    const t = setUp();
    expect(t.links.plugins()).toMatchObject([{ id: "fake", name: "Fake" }]);
    const attempt = await t.links.begin("fake", {});
    expect(attempt).toMatchObject({ plugin: "fake", userCode: "ABCD-EFGH" });
    expect(JSON.stringify(attempt)).not.toContain("device-code");
    expect((await t.links.list()).attempts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.store.links).toHaveLength(0);
    t.app.answer = "approved";
    await vi.advanceTimersByTimeAsync(5_000);

    const list = await t.links.list();
    expect(list.attempts).toEqual([]);
    expect(list.links).toMatchObject([
      {
        plugin: "fake",
        name: "fake",
        account: "Acme",
        settings: { url: "https://fake.example" },
        state: "linked",
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("iwl_x");
    expect(t.store.links[0]?.secret).toBe("iwl_x");
    expect(t.messages).toContainEqual({
      type: "app_link_settled",
      attemptId: attempt.id,
      outcome: "linked",
      linkId: list.links[0]?.id,
      detail: null,
    });
  });

  it("says when the person denied it, or it was cancelled", async () => {
    vi.useFakeTimers();
    const t = setUp();
    await t.links.begin("fake", {});
    t.app.answer = "denied";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.messages).toContainEqual(expect.objectContaining({ outcome: "denied" }));
    const again = await t.links.begin("fake", {});
    t.links.cancel(again.id);
    expect(t.messages).toContainEqual(expect.objectContaining({ outcome: "cancelled" }));
    expect((await t.links.list()).attempts).toEqual([]);
  });

  it("refuses settings the plugin won't take, and says when the app can't be reached", async () => {
    const t = setUp();
    await expect(t.links.begin("fake", { url: "nope" })).rejects.toMatchObject({
      code: "bad_request",
      message: "Fake URL isn't a URL",
    });
    t.app.down = true;
    const failed = t.links.begin("fake", {});
    await expect(failed).rejects.toMatchObject({ code: "unavailable" });
    // What went wrong is logged, not sent back, since it may carry a secret.
    await expect(failed).rejects.not.toThrow("iwl_x");
    expect(t.logs.join("\n")).toContain("ECONNREFUSED");
  });

  it("names a second link on the same plugin apart from the first", () => {
    expect(newLinkName("fake", new Set())).toBe("fake");
    expect(newLinkName("fake", new Set(["fake", "fake-2"]))).toBe("fake-3");
    // Never a built-in's name.
    expect(newLinkName("computer", new Set())).toBe("computer-2");
  });
});

describe("a nibblet's grant", () => {
  it("is made, handed to its guard (and its sub-agents'), changed and revoked", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    expect(await t.links.describe(linkId)).toMatchObject({ ceiling: ["read", "write"] });

    const grant = await t.links.setGrant("nib_1", linkId, ["read"], []);
    expect(grant).toMatchObject({ nibbletId: "nib_1", linkId, scopes: ["read"], state: "active" });
    expect(JSON.stringify(grant)).not.toContain("iwa_");
    expect(t.app.agents.get("agent-1")).toMatchObject({ externalId: "nib_1", scopes: ["read"] });
    expect(t.reconfigured).toEqual(["nib_1"]);
    expect(t.messages).toContainEqual({ type: "app_grants_changed", nibbletId: "nib_1" });

    const expected = {
      servers: [
        {
          name: "fake",
          url: "https://fake.example/mcp",
          headers: { authorization: "Bearer iwa_1" },
        },
      ],
      prompts: [
        {
          name: "fake",
          title: "Fake",
          account: "Acme",
          scopes: ["read"],
          providers: [],
          prompt: "Fake's tools act as you.",
        },
      ],
    };
    expect(await t.links.connections("nib_1")).toEqual(expected);
    // A sub-agent uses its host's, and can't have its own.
    expect(await t.links.connections("nib_2")).toEqual(expected);
    expect(await t.links.grants("nib_2")).toHaveLength(1);
    await expect(t.links.setGrant("nib_2", linkId, ["read"], [])).rejects.toMatchObject({
      code: "bad_request",
    });

    // Changing it keeps the same agent.
    await t.links.setGrant("nib_1", linkId, ["read", "write"], []);
    expect(t.app.made).toBe(1);
    expect(t.app.agents.get("agent-1")?.scopes).toEqual(["read", "write"]);
    expect(t.store.grants[0]?.scopes).toEqual(["read", "write"]);

    await t.links.removeGrant("nib_1", linkId);
    expect(t.app.agents.get("agent-1")?.revoked).toBe(true);
    expect(t.store.grants).toEqual([]);
    expect(await t.links.connections("nib_1")).toEqual({ servers: [], prompts: [] });
  });

  it("passes on what the app refused", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await expect(t.links.setGrant("nib_1", linkId, ["admin"], [])).rejects.toMatchObject({
      code: "bad_request",
      message: "This link can't grant admin",
    });
    expect(t.store.grants).toEqual([]);
  });

  it("is revoked when its nibblet is deleted, or kept and retried when the app is down", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await t.links.setGrant("nib_1", linkId, ["read"], []);
    t.app.down = true;
    await t.links.forget("nib_1");
    expect(t.store.grants).toMatchObject([{ nibbletId: "nib_1", state: "revoking" }]);
    expect(await t.links.connections("nib_1")).toEqual({ servers: [], prompts: [] });

    t.app.down = false;
    await t.links.sync();
    expect(t.app.agents.get("agent-1")?.revoked).toBe(true);
    expect(t.store.grants).toEqual([]);
  });

  it("is marked revoked when the app revoked it, and made again when saved", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await t.links.setGrant("nib_1", linkId, ["read"], []);
    const agent = t.app.agents.get("agent-1");
    if (agent) agent.revoked = true;
    t.reconfigured.length = 0;

    await t.links.sync();
    expect(t.store.grants).toMatchObject([{ state: "revoked", detail: "Revoked in Fake" }]);
    expect(t.reconfigured).toEqual(["nib_1"]);
    expect(await t.links.connections("nib_1")).toEqual({ servers: [], prompts: [] });
    // The app's own account name is kept up with too.
    expect((await t.links.list()).links[0]?.account).toBe("Acme Inc");

    await t.links.setGrant("nib_1", linkId, ["read"], []);
    expect(t.store.grants).toMatchObject([{ ref: "agent-2", state: "active", secret: "iwa_2" }]);
  });
});

describe("a link", () => {
  it("revokes everything when it's removed", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await t.links.setGrant("nib_1", linkId, ["read"], []);
    t.reconfigured.length = 0;
    await t.links.remove(linkId);
    expect(t.app.unlinked).toBe(1);
    expect(t.app.agents.get("agent-1")?.revoked).toBe(true);
    expect(t.store.links).toEqual([]);
    expect(t.store.grants).toEqual([]);
    expect(t.reconfigured).toEqual(["nib_1"]);
  });

  it("stops being handed out while the app can't be told it's removed, and goes once it can", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await t.links.setGrant("nib_1", linkId, ["read"], []);
    t.app.down = true;
    await t.links.remove(linkId);
    expect((await t.links.list()).links).toMatchObject([{ state: "removing" }]);
    expect(await t.links.connections("nib_1")).toEqual({ servers: [], prompts: [] });
    t.app.down = false;
    await t.links.sync();
    expect(t.app.unlinked).toBe(1);
    expect(t.store.links).toEqual([]);
  });

  it("is marked revoked, grants and all, when the app answers 401", async () => {
    vi.useFakeTimers();
    const t = setUp();
    const linkId = await link(t);
    await t.links.setGrant("nib_1", linkId, ["read"], []);
    t.app.linkRevoked = true;
    t.reconfigured.length = 0;

    await expect(t.links.describe(linkId)).rejects.toMatchObject({ code: "conflict" });
    expect((await t.links.list()).links).toMatchObject([
      { state: "revoked", detail: "Fake says this link was revoked" },
    ]);
    expect(t.store.grants).toMatchObject([{ state: "revoked" }]);
    expect(t.reconfigured).toEqual(["nib_1"]);
    expect(await t.links.connections("nib_1")).toEqual({ servers: [], prompts: [] });
    await expect(t.links.setGrant("nib_1", linkId, ["read"], [])).rejects.toMatchObject({
      code: "conflict",
    });

    // Turning the grant off, or removing the link, needs nothing more from the app.
    await t.links.removeGrant("nib_1", linkId);
    expect(t.store.grants).toEqual([]);
    await t.links.remove(linkId);
    expect(t.store.links).toEqual([]);
  });

  it("is found revoked by the regular check too", async () => {
    vi.useFakeTimers();
    const t = setUp();
    await link(t);
    t.app.linkRevoked = true;
    await t.links.sync();
    expect((await t.links.list()).links).toMatchObject([{ state: "revoked" }]);
  });
});

describe("adopting a link the app made itself", () => {
  it("keeps it as a link made here would be, once, with the newest secret", async () => {
    const t = setUp();
    const adopted = await t.links.adopt("fake", {}, "iwl_x");
    expect(adopted).toMatchObject({
      plugin: "fake",
      name: "fake",
      account: "Acme",
      settings: { url: "https://fake.example" },
      state: "linked",
    });
    expect(JSON.stringify(adopted)).not.toContain("iwl_x");
    expect(t.messages).toContainEqual({ type: "app_links_changed" });

    // Again, say the installer ran twice, or the app handed over a new secret.
    const again = await t.links.adopt("fake", {}, "iwl_y");
    expect(again.id).toBe(adopted.id);
    expect(t.store.links).toHaveLength(1);
    expect(t.store.links[0]?.secret).toBe("iwl_y");

    // It works like any other link.
    await t.links.setGrant("nib_1", adopted.id, ["read"], []);
    expect(t.app.agents.get("agent-1")).toMatchObject({ externalId: "nib_1" });
  });

  it("keeps nothing when the app doesn't take the secret", async () => {
    const t = setUp();
    await expect(t.links.adopt("fake", {}, "iwl_wrong")).rejects.toMatchObject({
      code: "bad_request",
      message: "Fake doesn't take that link's credential",
    });
    t.app.down = true;
    await expect(t.links.adopt("fake", {}, "iwl_x")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(t.store.links).toEqual([]);
  });

  it("is refused for a plugin that can only link with a code", async () => {
    const { factory } = fakeApp();
    const t = setUp();
    const codeOnly = defineAppLinkFactory({
      ...factory,
      id: "codeonly",
      create: (settings, deps) => ({ ...factory.create(settings, deps), adopt: undefined }),
    });
    const links = new AppLinks({
      store: t.store,
      factories: [codeOnly],
      publish: () => undefined,
      label: async () => "",
      reconfigure: async () => undefined,
    });
    await expect(links.adopt("codeonly", {}, "iwl_x")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("is only for the server's owner token", async () => {
    const adopt = vi.fn(async () => ({}));
    const handlers = createHandlers({ appLinks: { adopt } } as unknown as Services);
    const input = { plugin: "fake", settings: {}, secret: "iwl_x" };
    await expect(handlers.appLinks.adopt(input, { owner: false })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(adopt).not.toHaveBeenCalled();
    await handlers.appLinks.adopt(input, { owner: true });
    expect(adopt).toHaveBeenCalledWith("fake", {}, "iwl_x");
  });
});
