import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  AppLinkError,
  AppLinkRevokedError,
  type LinkRef,
  type SignInStart,
} from "@nibblets/app-link";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { t3code, t3codePlugin, T3_SYSTEMS, T3_TOOLS } from "./index.ts";

const BASE = "https://mac.t3.example";
const CALLBACK = "https://pip.example/api/app-links/callback";

/**
 * A T3 Code environment: its OAuth sign-in for outside agents, and its MCP
 * server with a read tool and one that acts, behind the token it issued.
 */
function fakeT3(options: { readOnly?: boolean } = {}) {
  const t3 = {
    calls: [] as { method: string; path: string }[],
    registered: [] as { client_name: string; redirect_uris: string[] }[],
    authorized: null as URL | null,
    token: "t3_session",
    /** Its sign-ins stop working, as after 30 days. */
    expired: false,
  };
  const codes = new Map<string, string>();

  const mcp = async (request: Request) => {
    if (t3.expired || request.headers.get("authorization") !== `Bearer ${t3.token}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const server = new McpServer({ name: "t3-code", version: "0.1.4" });
    server.registerTool(
      "t3_environment_read",
      {
        description: "Read this server's identity and preferences.",
        inputSchema: { environmentId: z.string().optional() },
        outputSchema: { environmentId: z.string(), label: z.string() },
        annotations: { readOnlyHint: true },
      },
      async () => {
        const out = { environmentId: "env_mac", label: "Astrid's Mac" };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    t3.calls.push({ method: request.method, path: url.pathname });
    switch (`${request.method} ${url.pathname}`) {
      case "GET /.well-known/oauth-protected-resource/mcp":
        return Response.json({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
      case "GET /.well-known/oauth-authorization-server":
        return Response.json({
          issuer: BASE,
          authorization_endpoint: `${BASE}/oauth/mcp/authorize`,
          token_endpoint: `${BASE}/oauth/mcp/token`,
          registration_endpoint: `${BASE}/oauth/mcp/register`,
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      case "POST /oauth/mcp/register": {
        const body = z
          .object({ client_name: z.string(), redirect_uris: z.array(z.string()) })
          .parse(await request.json());
        t3.registered.push(body);
        return Response.json({ client_id: "signed-client" }, { status: 201 });
      }
      case "POST /oauth/mcp/token": {
        const form = new URLSearchParams(await request.text());
        const challenge = codes.get(form.get("code") ?? "");
        if (!challenge || !form.get("code_verifier") || form.get("client_id") !== "signed-client") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(form.get("code") ?? "");
        return Response.json({
          access_token: t3.token,
          token_type: "Bearer",
          expires_in: 30 * 24 * 60 * 60,
          scope: options.readOnly
            ? "orchestration:read"
            : "orchestration:read orchestration:operate",
        });
      }
      case "POST /mcp":
      case "GET /mcp":
      case "DELETE /mcp":
        return mcp(request);
      default:
        return new Response("not found", { status: 404 });
    }
  };

  /** The person approves on T3 Code's page: it sends them back with a code. */
  const approve = (start: SignInStart): URLSearchParams => {
    const authorize = new URL(start.verificationUrl);
    t3.authorized = authorize;
    codes.set("code-1", authorize.searchParams.get("code_challenge") ?? "");
    return new URLSearchParams({
      code: "code-1",
      state: authorize.searchParams.get("state") ?? "",
      iss: BASE,
    });
  };

  return { t3, fetch, approve };
}

async function linked(options: { readOnly?: boolean } = {}) {
  const fake = fakeT3(options);
  const plugin = t3codePlugin({ url: BASE }, { fetch: fake.fetch });
  const start = await plugin.begin({ label: "Nibblets on PogAir-4", callbackUrl: CALLBACK });
  const answer = await plugin.finish(start, fake.approve(start));
  if (answer.status !== "linked") throw new Error(`not linked: ${answer.status}`);
  return { ...fake, plugin, link: answer.link, account: answer.account };
}

describe("linking T3 Code", () => {
  it("registers, sends the person to approve, and keeps the sign-in it gets back", async () => {
    const fake = fakeT3();
    const plugin = t3codePlugin({ url: BASE }, { fetch: fake.fetch });
    const start = await plugin.begin({ label: "Nibblets on PogAir-4", callbackUrl: CALLBACK });
    expect(start.via).toBe("sign_in");
    expect(fake.t3.registered).toEqual([
      expect.objectContaining({ client_name: "Nibblets on PogAir-4", redirect_uris: [CALLBACK] }),
    ]);
    const authorize = new URL(start.verificationUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${BASE}/oauth/mcp/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: "signed-client",
      redirect_uri: CALLBACK,
      state: start.state,
      code_challenge_method: "S256",
      scope: "orchestration:read orchestration:operate",
      resource: `${BASE}/mcp`,
    });

    const answer = await plugin.finish(start, fake.approve(start));
    expect(answer).toMatchObject({
      status: "linked",
      link: { ref: "env_mac" },
      account: "Astrid's Mac on T3 Code",
    });
  });

  it("says when it was turned down, and refuses a sign-in that came back from elsewhere", async () => {
    const fake = fakeT3();
    const plugin = t3codePlugin({ url: BASE }, { fetch: fake.fetch });
    const start = await plugin.begin({ label: "Nibblets", callbackUrl: CALLBACK });
    expect(
      await plugin.finish(
        start,
        new URLSearchParams({ error: "access_denied", state: start.state, iss: BASE }),
      ),
    ).toEqual({ status: "denied" });
    const elsewhere = fake.approve(start);
    elsewhere.set("iss", "https://evil.example");
    await expect(plugin.finish(start, elsewhere)).rejects.toThrow("came back from somewhere else");
  });

  it("can't link without an address to send the person back to", async () => {
    const fake = fakeT3();
    const plugin = t3codePlugin({ url: BASE }, { fetch: fake.fetch });
    await expect(plugin.begin({ label: "Nibblets", callbackUrl: null })).rejects.toBeInstanceOf(
      AppLinkError,
    );
    expect(fake.t3.calls).toEqual([]);
  });
});

describe("granting T3 Code", () => {
  it("offers every tool by system when T3 Code let it act, and only what reads when not", async () => {
    const full = await linked();
    const all = await full.plugin.describe(full.link);
    expect(all.scopeGroups.map((g) => g.title)).toEqual(T3_SYSTEMS.map((s) => s.title));
    expect(all.ceiling).toContain("t3_thread_launch");
    expect(all.scopeGroups[0]?.scopes[0]).toEqual({
      value: "t3_thread_list",
      label: "List threads",
    });

    const reader = await linked({ readOnly: true });
    const reading = await reader.plugin.describe(reader.link);
    expect(reading.ceiling).toContain("t3_thread_read");
    // Its reads work on a read-only sign-in, and T3 Code refuses its answers.
    expect(reading.ceiling).toContain("t3_pending_request");
    expect(reading.ceiling).not.toContain("t3_thread_launch");
    // A system with nothing that reads isn't offered at all.
    expect(reading.scopeGroups.map((g) => g.title)).not.toContain("Attachments");
    await expect(
      reader.plugin.grant(reader.link, {
        externalId: "nib_1",
        label: "Pip",
        scopes: ["t3_thread_read", "t3_thread_launch"],
        providers: [],
      }),
    ).rejects.toThrow("can't grant t3_thread_launch");
  });

  it("makes grants the gate keeps: the link's sign-in, and only the tools ticked", async () => {
    const { plugin, link } = await linked();
    const grant = await plugin.grant(link, {
      externalId: "nib_1",
      label: "Pip",
      scopes: ["t3_thread_send", "t3_thread_read", "t3_thread_send"],
      providers: [],
    });
    expect(grant).toEqual({
      ref: "nib_1",
      secret: "",
      scopes: ["t3_thread_read", "t3_thread_send"],
      providers: [],
    });
    expect(plugin.connection({ ...grant }, link)).toMatchObject({
      mcp: {
        url: `${BASE}/mcp`,
        headers: { authorization: "Bearer t3_session" },
        tools: ["t3_thread_read", "t3_thread_send"],
      },
    });
    const fewer = await plugin.update(link, grant, { scopes: ["t3_thread_read"] });
    expect(plugin.connection({ ...grant, ...fewer }, link).mcp?.tools).toEqual(["t3_thread_read"]);
  });

  it("won't grant a tool it doesn't know, or nothing at all", async () => {
    const { plugin, link } = await linked();
    const ask = (scopes: string[]) =>
      plugin.grant(link, { externalId: "nib_1", label: "Pip", scopes, providers: [] });
    await expect(ask(["delegate_task"])).rejects.toThrow("no tool a nibblet can be given");
    await expect(ask([])).rejects.toThrow("Tick what it may do");
  });
});

describe("T3 Code's tools", () => {
  it("are each in one system, once", () => {
    const names = T3_SYSTEMS.flatMap((s) => s.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
    expect(T3_TOOLS.size).toBe(names.length);
  });

  it("leave out the ones only a T3 Code thread can call", () => {
    for (const name of ["delegate_task", "preview_open", "device_open", "t3_worktree_handoff"]) {
      expect(T3_TOOLS.has(name)).toBe(false);
    }
  });
});

describe("keeping up with T3 Code", () => {
  it("finds the link revoked once T3 Code stops taking its sign-in", async () => {
    const { t3, plugin, link } = await linked();
    expect(await plugin.inspect(link)).toEqual({ account: "Astrid's Mac on T3 Code", live: [] });
    t3.expired = true;
    const inspected = plugin.inspect(link);
    await expect(inspected).rejects.toBeInstanceOf(AppLinkRevokedError);
    await expect(inspected).rejects.toMatchObject({ what: "link" });
  });

  it("doesn't ask once the sign-in has plainly run out", async () => {
    const { t3, plugin, link } = await linked();
    const secret = z.object({ expiresAt: z.number() }).loose().parse(JSON.parse(link.secret));
    const stale: LinkRef = {
      ...link,
      secret: JSON.stringify({ ...secret, expiresAt: Date.now() - 1 }),
    };
    const before = t3.calls.length;
    await expect(plugin.inspect(stale)).rejects.toBeInstanceOf(AppLinkRevokedError);
    expect(t3.calls).toHaveLength(before);
  });
});

describe("the T3 Code factory", () => {
  const deps = { fetch };

  it("takes the environment's MCP URL or its address, over https or on this computer", () => {
    expect(() => t3code.create({ url: "https://mac.t3.example/mcp" }, deps)).not.toThrow();
    expect(() => t3code.create({ url: "http://localhost:3773" }, deps)).not.toThrow();
    expect(() => t3code.create({ url: "http://100.64.0.1:3773" }, deps)).toThrow(
      "should be an https URL",
    );
    expect(() => t3code.create({ url: "not a url" }, deps)).toThrow("isn't a URL");
    expect(t3code.grants).toBe("gate");
    expect(t3code.icon).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("serves the MCP server at the environment's /mcp, whichever was given", async () => {
    const fake = fakeT3();
    const plugin = t3code.create({ url: `${BASE}/mcp/` }, { fetch: fake.fetch });
    const start = await plugin.begin({ label: "Nibblets", callbackUrl: CALLBACK });
    expect(new URL(start.verificationUrl).searchParams.get("resource")).toBe(`${BASE}/mcp`);
  });
});
