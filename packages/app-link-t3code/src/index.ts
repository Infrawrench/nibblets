import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AppLinkError,
  AppLinkRevokedError,
  defineAppLinkFactory,
  defineField,
  type AppLinkDeps,
  type LinkRef,
  type SignInLinking,
} from "@nibblets/app-link";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  pkce,
  randomState,
  readReturn,
  registerClient,
  SignInError,
  type AuthServer,
} from "@nibblets/oauth";
import type { AppLinkDescription } from "@nibblets/protocol";
import { z } from "zod";
import { T3CODE_ICON } from "./logo.ts";
import { T3_SYSTEMS, T3_TOOLS } from "./tools.ts";

export { T3_SYSTEMS, T3_TOOLS, type T3System, type T3Tool, type ToolUse } from "./tools.ts";

/**
 * T3 Code (t3.codes, pingdotgg/t3code) as an app link. T3 Code runs coding
 * agents on the person's own machine, and each of its environments serves
 * an MCP server (`/mcp`) that agents it didn't start can sign in to. That's
 * how a nibblet uses it: starting, messaging, waiting on and reading
 * T3 Code's threads.
 *
 * Linking is that sign-in: OAuth as MCP servers have it, with T3 Code's
 * page sending the person back to the server. They approve it there with a
 * pairing code from T3 Code's Settings → Sharing & access, choosing read
 * only or how much a thread it starts may do. T3 Code has no way to make a
 * credential per nibblet, so its grants are the gate's: every nibblet uses
 * the link's sign-in, and the gate lists and allows only the tools it was
 * granted. Each tool is a scope, grouped by T3 Code's systems (`tools.ts`).
 *
 * A sign-in lasts 30 days and isn't renewed, after which the link shows as
 * revoked until it's linked again; its grants carry on once it is. T3 Code
 * has no route to sign out either, so unlinking only forgets the link here.
 */

/** What to ask T3 Code for: reading, and acting through threads. */
const SCOPES = ["orchestration:read", "orchestration:operate"] as const;
const OPERATE = "orchestration:operate";

/** How long the person has to approve signing in, pairing code and all. */
const SIGN_IN_MS = 15 * 60_000;

const TIMEOUT_MS = 15_000;

const ServerRecord = z.object({
  authorize: z.string(),
  token: z.string(),
  register: z.string().nullable(),
  issuer: z.string().nullable(),
});

/** What a sign-in in progress is finished with: the start's secret, as JSON. */
const Pending = z.object({
  server: ServerRecord,
  clientId: z.string(),
  redirectUri: z.string(),
  verifier: z.string(),
  resource: z.string(),
});

/** What the link authenticates with: its secret, as JSON. */
const Session = z.object({
  token: z.string().min(1),
  /** Epoch milliseconds; null when T3 Code didn't say. */
  expiresAt: z.number().nullable(),
  /** What T3 Code granted; null when it didn't say, so T3 Code's own limits are all there are. */
  scopes: z.array(z.string()).nullable(),
});
type Session = z.infer<typeof Session>;

/** RFC 9728 metadata, the parts used here. */
const ProtectedResource = z
  .object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
  .loose();

/** What `t3_environment_read` says, the parts used here. */
const Environment = z.object({ environmentId: z.string().min(1), label: z.string() }).loose();
type Environment = z.infer<typeof Environment>;

/** What `t3_environment_links` says: the other machines linked to this environment. */
const Linked = z
  .object({
    links: z.array(
      z.object({ environmentId: z.string().min(1), label: z.string(), status: z.string() }).loose(),
    ),
  })
  .loose();

/** A machine a grant can be narrowed to: this environment, or one linked to it. */
interface Machine {
  id: string;
  name: string;
}

/** What a nibblet is told about its T3 Code tools, beside its scopes. */
const PROMPT =
  "T3 Code's tools drive coding agents in T3 Code, on your person's own machine. Start a thread with `t3_thread_launch`, message one with `t3_thread_send` (give it a `clientRequestId`, so a retry sends once), wait on it with `t3_thread_wait`, and read it with `t3_thread_read`. Answer a thread's questions with `t3_pending_request`. Commands and file changes a thread asks to make are approved by your person in T3 Code's own app, not here, so if a thread is waiting on one, tell them. T3 Code also caps how much a thread may do, as your person chose when they linked it. To act on another of their machines linked in T3 Code, pass its `environmentId` (from `t3_environment_links`); without one, a tool acts on the machine you're linked to. Only the tools you were given are listed, and you may only act on the machines you were given: if you need more, ask your person to tick it in your settings.";

const REVOKED =
  "T3 Code no longer takes this link's sign-in (they last 30 days): link it again from Settings";

export interface T3CodeOptions {
  /** The environment's address, e.g. its T3 Connect one: `https://…`, without `/mcp`. */
  url: string;
}

/** Whether T3 Code let the sign-in act, rather than only read. */
function mayAct(session: Session): boolean {
  return session.scopes === null || session.scopes.includes(OPERATE);
}

/**
 * The tools a sign-in can be granted: every one when it may act, else the
 * ones that read, since T3 Code refuses the rest.
 */
function ceiling(session: Session): string[] {
  const act = mayAct(session);
  return [...T3_TOOLS.values()].filter((t) => act || t.does !== "changes").map((t) => t.name);
}

/** The tools a grant gets, in the catalogue's order: refused if any is outside the ceiling. */
function clamp(scopes: readonly string[], session: Session): string[] {
  const unknown = scopes.filter((s) => !T3_TOOLS.has(s));
  if (unknown.length > 0) {
    throw new AppLinkError(
      `T3 Code has no tool a nibblet can be given called ${unknown.join(", ")}`,
    );
  }
  const top = new Set(ceiling(session));
  const over = scopes.filter((s) => !top.has(s));
  if (over.length > 0) {
    throw new AppLinkError(
      `This link can only read: T3 Code approved it read-only, so it can't grant ${over.join(", ")}. Link it again, choosing more, for a nibblet to change things.`,
    );
  }
  const wanted = new Set(scopes);
  const granted = [...T3_TOOLS.keys()].filter((name) => wanted.has(name));
  if (granted.length === 0) throw new AppLinkError("Tick what it may do in T3 Code");
  return granted;
}

function session(link: LinkRef): Session {
  return Session.parse(JSON.parse(link.secret));
}

/** An OAuth step, with what T3 Code refused said as an app link's error. */
async function signingIn<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof SignInError) throw new AppLinkError(`T3 Code: ${err.message}`);
    throw err;
  }
}

export function t3codePlugin(
  options: T3CodeOptions,
  deps: Pick<AppLinkDeps, "fetch">,
): SignInLinking {
  const base = options.url.replace(/\/+$/, "");
  const mcpUrl = `${base}/mcp`;

  /** Where T3 Code signs agents in, and the resource it signs them in to. */
  async function signInServer(): Promise<{ server: AuthServer; resource: string }> {
    let issuer = base;
    let resource = mcpUrl;
    try {
      const res = await deps.fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const metadata = res.ok ? ProtectedResource.safeParse(await res.json()) : null;
      if (metadata?.success) {
        issuer = metadata.data.authorization_servers[0] ?? issuer;
        resource = metadata.data.resource;
      }
    } catch {
      // An older T3 Code, or none at that path: it signs in where it's served.
    }
    const server = await signingIn(() => discover(issuer, deps));
    // The person is sent there, so it's this T3 Code's own page or nothing.
    if (new URL(server.authorize).origin !== new URL(base).origin) {
      throw new AppLinkError("T3 Code sent a page to sign in on that isn't its own");
    }
    return { server, resource };
  }

  /** Runs some calls on T3 Code's MCP server with a sign-in; 401 means it's run out or revoked. */
  async function withMcp<T>(token: string, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "nibblets", version: "0.7.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, init) =>
        deps.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) }),
    });
    try {
      await client.connect(transport);
      return await work(client);
    } catch (err) {
      if (err instanceof StreamableHTTPError && err.code === 401) {
        throw new AppLinkRevokedError("link", REVOKED);
      }
      throw err;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** What a tool answered: its structured content, or the JSON of its text. */
  async function read<T extends z.ZodType>(
    client: Client,
    name: string,
    schema: T,
  ): Promise<z.output<T>> {
    const result = await client.callTool({ name, arguments: {} });
    const text = z
      .array(z.object({ type: z.literal("text"), text: z.string() }).loose())
      .safeParse(result.content);
    const said = text.success ? text.data.map((c) => c.text).join("\n") : "";
    if (result.isError) throw new Error(`T3 Code refused ${name}: ${said}`);
    const structured = schema.safeParse(result.structuredContent);
    if (structured.success) return structured.data;
    return schema.parse(JSON.parse(said));
  }

  /** Who the environment is, as T3 Code says. */
  function environment(token: string): Promise<Environment> {
    return withMcp(token, (client) => read(client, "t3_environment_read", Environment));
  }

  /**
   * Who the environment is, and the machines a grant can be narrowed to:
   * it, then the ones linked to it, saying which can't be reached now.
   */
  function machines(token: string): Promise<{ env: Environment; machines: Machine[] }> {
    return withMcp(token, async (client) => {
      const env = await read(client, "t3_environment_read", Environment);
      let linked: z.infer<typeof Linked>["links"] = [];
      try {
        linked = (await read(client, "t3_environment_links", Linked)).links;
      } catch {
        // Linked environments is off there (it's a beta), or T3 Code is older: just this one.
      }
      return {
        env,
        machines: [
          { id: env.environmentId, name: env.label.trim() || env.environmentId },
          ...linked
            .filter((l) => l.environmentId !== env.environmentId)
            .map((l) => ({
              id: l.environmentId,
              name: `${l.label.trim() || l.environmentId}${l.status === "reachable" ? "" : ` (${l.status})`}`,
            })),
        ],
      };
    });
  }

  /** The machines a grant is narrowed to, in T3 Code's order; empty for all, and any linked later. */
  async function narrow(link: LinkRef, providers: readonly string[]): Promise<string[]> {
    if (providers.length === 0) return [];
    const known = (await machines(live(link).token)).machines.map((m) => m.id);
    const gone = providers.filter((p) => !known.includes(p));
    if (gone.length > 0) {
      throw new AppLinkError(
        `T3 Code has no machine ${gone.join(", ")} linked any more: untick it, or link it again there`,
      );
    }
    return known.filter((id) => providers.includes(id));
  }

  /** "Astrid's MacBook on T3 Code". */
  const account = (env: Environment) => `${env.label.trim() || "An environment"} on T3 Code`;

  /** A link's sign-in, unless it has plainly run out already. */
  function live(link: LinkRef): Session {
    const current = session(link);
    if (current.expiresAt !== null && current.expiresAt <= Date.now()) {
      throw new AppLinkRevokedError("link", REVOKED);
    }
    return current;
  }

  return {
    async begin(request) {
      const callbackUrl = request.callbackUrl;
      if (!callbackUrl) {
        throw new AppLinkError(
          "T3 Code sends you back to Nibblets once you approve, so open Nibblets over https or on this computer, or give this server an address on the internet first",
        );
      }
      const { server, resource } = await signInServer();
      const clientId = await signingIn(() =>
        registerClient(
          server,
          { name: request.label.slice(0, 100), uri: null, redirectUri: callbackUrl },
          SCOPES,
          deps,
        ),
      );
      const { verifier, challenge } = await pkce();
      const state = randomState();
      const pending: z.infer<typeof Pending> = {
        server,
        clientId,
        redirectUri: callbackUrl,
        verifier,
        resource,
      };
      return {
        via: "sign_in",
        secret: JSON.stringify(pending),
        state,
        verificationUrl: authorizeUrl(server, {
          clientId,
          redirectUri: callbackUrl,
          state,
          challenge,
          scopes: SCOPES,
          resource,
        }),
        expiresAt: new Date(Date.now() + SIGN_IN_MS),
      };
    },

    async finish(start, query) {
      const pending = Pending.parse(JSON.parse(start.secret));
      const answer = readReturn(pending.server, query);
      if (answer.status === "denied") return { status: "denied" };
      if (answer.status === "failed") throw new AppLinkError(`T3 Code: ${answer.message}`);
      const grant = await signingIn(() =>
        exchangeCode(
          pending.server,
          {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            code: answer.code,
            verifier: pending.verifier,
            resource: pending.resource,
          },
          deps,
        ),
      );
      const env = await environment(grant.access);
      const signedIn: Session = {
        token: grant.access,
        expiresAt: grant.expiresAt,
        scopes: grant.scopes,
      };
      return {
        status: "linked",
        link: { ref: env.environmentId, secret: JSON.stringify(signedIn) },
        account: account(env),
      };
    },

    async describe(link): Promise<AppLinkDescription> {
      const current = live(link);
      const { env, machines: found } = await machines(current.token);
      const top = new Set(ceiling(current));
      return {
        account: account(env),
        scopeGroups: T3_SYSTEMS.map((system) => ({
          title: system.title,
          scopes: system.tools
            .filter((t) => top.has(t.name))
            .map((t) => ({ value: t.name, label: t.label })),
        })).filter((group) => group.scopes.length > 0),
        providers: found,
        ceiling: [...top],
        narrowable: null,
      };
    },

    async grant(link, request) {
      return {
        ref: request.externalId,
        // The gate uses the link's sign-in; a grant has none of its own.
        secret: "",
        scopes: clamp(request.scopes, live(link)),
        providers: await narrow(link, request.providers),
      };
    },

    async update(link, _grant, request) {
      return {
        scopes: clamp(request.scopes ?? [], live(link)),
        providers: await narrow(link, request.providers ?? []),
      };
    },

    async revoke() {
      // Nothing in T3 Code to revoke: the gate stops handing it out.
    },

    async unlink() {
      // T3 Code has no route to sign out; its Settings → Sharing & access revokes it.
    },

    async inspect(link) {
      const env = await environment(live(link).token);
      return { account: account(env), live: [] };
    },

    connection(grant, link) {
      return {
        mcp: {
          url: mcpUrl,
          headers: { authorization: `Bearer ${session(link).token}` },
          // Only what was ticked, and that T3 Code still has a tool by.
          tools: grant.scopes.filter((s) => T3_TOOLS.has(s)),
          // Only on the machines ticked: the one a call names, else this one.
          ...(grant.providers.length > 0
            ? {
                providers: {
                  argument: "environmentId",
                  allowed: grant.providers,
                  home: link.ref,
                  actHome: [...T3_TOOLS.values()].filter((t) => t.namesMachine).map((t) => t.name),
                },
              }
            : {}),
        },
        prompt: PROMPT,
      };
    },
  };
}

const URL_FIELD = defineField("url", "T3 Code address", {
  required: true,
  placeholder: "https://…",
  hint: "Its MCP URL (Settings → Environments → Copy MCP URL in T3 Code), or its T3 Connect address. The nibblet reaches it from its container, so not localhost.",
});

export const t3code = defineAppLinkFactory({
  id: "t3code",
  name: "T3 Code",
  description:
    "Let nibblets start and steer T3 Code's coding agents, each with only the tools you tick. Unlinking doesn't sign out of T3 Code: revoke it there under Settings → Sharing & access.",
  icon: T3CODE_ICON,
  fields: [URL_FIELD],
  grants: "gate",
  create(settings, deps) {
    const url = settings[URL_FIELD.key]?.trim() ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppLinkError(`${URL_FIELD.label} isn't a URL`);
    }
    // Plain http only for one on this computer, since the sign-in goes over it.
    const local = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(
      parsed.hostname,
    );
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      throw new AppLinkError(`${URL_FIELD.label} should be an https URL`);
    }
    // Its MCP URL is what T3 Code copies; the environment is what's before `/mcp`.
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
    return t3codePlugin({ url: `${parsed.origin}${path}` }, deps);
  },
});
