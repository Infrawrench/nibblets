import {
  AppLinkError,
  AppLinkRevokedError,
  defineAppLinkFactory,
  defineField,
  type AppLinkDeps,
  type CodeLinking,
  type LinkRef,
} from "@nibblets/app-link";
import type { AppLinkDescription } from "@nibblets/protocol";
import { z } from "zod";
import { INFRAWRENCH_ICON } from "./logo.ts";

/**
 * Infrawrench (infrawrench.com) as an app link. Linking makes an agent link
 * in one Infrawrench organisation, approved there by someone who may invite
 * people, who also sets the most it may ever grant (its ceiling). Each
 * nibblet granted on it becomes an agent of its own in that organisation:
 * its own `iwa_` credential, its own name in the audit log and in
 * Settings → Agents, and only the scopes ticked for it. The nibblet uses it
 * through Infrawrench's MCP server, which its guard serves behind the gate.
 *
 * The routes are Infrawrench's agent link API: `/api/agent-links/requests*`
 * to link, then `/api/agent-link*` with the link's `iwl_` credential.
 */

export const INFRAWRENCH_URL = "https://app.infrawrench.com";

/** What Infrawrench is told this platform is. */
const PLATFORM = "nibblets";

const TIMEOUT_MS = 15_000;

const ErrorBody = z.object({ error: z.string(), code: z.string().optional() }).loose();

const Started = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string(),
  verificationUrlComplete: z.string().nullish(),
  expiresIn: z.number().positive(),
  interval: z.number().positive(),
});

const LinkInfo = z.object({
  id: z.string(),
  organizationName: z.string(),
  effectiveScopes: z.array(z.string()),
  /** The scopes `providers` can limit; with any provider chosen, a grant may only have these. */
  narrowableScopes: z.array(z.string()).optional(),
  scopeGroups: z.array(
    z.object({
      title: z.string(),
      scopes: z.array(z.object({ value: z.string(), label: z.string() })),
    }),
  ),
  providers: z.array(z.object({ id: z.string(), displayName: z.string() })).default([]),
});
type LinkInfo = z.infer<typeof LinkInfo>;

const Token = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("approved"), credential: z.string().min(1), link: LinkInfo }),
]);

const Agent = z.object({
  id: z.string(),
  scopes: z.array(z.string()),
  providers: z.array(z.string()).nullish(),
  revokedAt: z.string().nullish(),
});

const Made = z.object({ agent: Agent, credential: z.string().min(1) });

/** "Acme on Infrawrench". */
const account = (link: LinkInfo) => `${link.organizationName} on Infrawrench`;

/** What a nibblet is told about its Infrawrench tools, beside its scopes. */
const PROMPT =
  "Infrawrench's tools act there as you: an agent of your own in the organisation, with its own credential, and only the scopes you were given. What you do shows under your name in its audit log. A tool you weren't given isn't listed, and a call outside your scopes is refused: if you need more, ask your person to tick it in your settings. Don't sign in to Infrawrench in the browser as your person instead.";

export interface InfrawrenchOptions {
  /** Where Infrawrench is, e.g. `https://app.infrawrench.com`. */
  url: string;
}

/**
 * Infrawrench said no. Its own messages are safe to show; 401 on a link
 * route means the link was revoked, and 404 on an agent that it was.
 */
class Refused extends AppLinkError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(status: number, message: string, code: string | undefined, body: unknown) {
    super(`Infrawrench: ${message}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function infrawrenchPlugin(
  options: InfrawrenchOptions,
  deps: Pick<AppLinkDeps, "fetch">,
): CodeLinking {
  const base = options.url.replace(/\/+$/, "");

  async function call(
    method: string,
    path: string,
    { body, secret }: { body?: object; secret?: string } = {},
  ): Promise<unknown> {
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; the status says enough.
    }
    if (res.status >= 400 && res.status < 500) {
      const error = ErrorBody.safeParse(parsed);
      throw new Refused(
        res.status,
        error.success ? error.data.error : `HTTP ${res.status}`,
        error.success ? error.data.code : undefined,
        parsed,
      );
    }
    // A server error leaves it unclear whether anything happened.
    if (!res.ok) throw new Error(`Infrawrench: HTTP ${res.status} for ${method} ${path}`);
    return parsed;
  }

  /** A call with the link's credential; 401 means Infrawrench revoked the link. */
  async function asLink(
    link: LinkRef,
    method: string,
    path: string,
    body?: object,
  ): Promise<unknown> {
    try {
      return await call(method, path, { secret: link.secret, ...(body ? { body } : {}) });
    } catch (err) {
      if (err instanceof Refused && err.status === 401) {
        throw new AppLinkRevokedError("link", "Infrawrench says this link was revoked");
      }
      throw err;
    }
  }

  /** A call about one agent; 404 means it's gone (revoked, or never made). */
  async function asAgent(
    link: LinkRef,
    method: string,
    path: string,
    body?: object,
  ): Promise<unknown> {
    try {
      return await asLink(link, method, path, body);
    } catch (err) {
      if (err instanceof Refused && err.status === 404) {
        throw new AppLinkRevokedError("grant", "Infrawrench says this agent was revoked");
      }
      throw err;
    }
  }

  const agentPath = (id: string) => `/api/agent-link/agents/${encodeURIComponent(id)}`;

  /**
   * Infrawrench refused what a grant asked for: says why in a person's
   * words, rather than its own. `narrowed` when the grant named providers,
   * which only some scopes can be limited to.
   */
  function refusal(err: unknown, narrowed: boolean): never {
    if (err instanceof Refused && err.code === "scope_not_allowed") {
      const scopes = z.object({ scopes: z.array(z.string()) }).safeParse(err.body);
      const which = scopes.success && scopes.data.scopes.length > 0 ? scopes.data.scopes : null;
      throw new AppLinkError(
        narrowed
          ? `Only for some providers, it can't have ${which?.join(", ") ?? "some of those scopes"}: they'd reach every provider. Untick them, or choose no providers.`
          : which
            ? `This link can't grant ${which.join(", ")}`
            : "This link can't grant some of those scopes",
      );
    }
    if (err instanceof Refused && err.code === "too_many_agents") {
      throw new AppLinkError(
        "This Infrawrench link has as many agents as it can hold. Turn Infrawrench off for a nibblet that doesn't need it, or revoke agents in Infrawrench's Settings → Agents.",
      );
    }
    if (err instanceof Refused && err.code === "invalid_provider") {
      throw new AppLinkError("Infrawrench doesn't know one of those providers any more");
    }
    throw err;
  }

  return {
    async begin(request) {
      const started = Started.parse(
        await call("POST", "/api/agent-links/requests", {
          body: {
            platform: PLATFORM,
            label: request.label.slice(0, 80),
            ...(request.requestedScopes?.length
              ? { requestedScopes: request.requestedScopes }
              : {}),
          },
        }),
      );
      // The person is sent there, so it's Infrawrench's own page or nothing:
      // never a `javascript:` URL, nor somewhere else.
      const ours = (url: string) => {
        try {
          return new URL(url).origin === new URL(base).origin;
        } catch {
          return false;
        }
      };
      const complete = started.verificationUrlComplete ?? null;
      if (!ours(started.verificationUrl) || (complete !== null && !ours(complete))) {
        throw new AppLinkError("Infrawrench sent a page to approve the link that isn't its own");
      }
      return {
        via: "code",
        secret: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        verificationUrlComplete: started.verificationUrlComplete ?? null,
        expiresAt: new Date(Date.now() + started.expiresIn * 1000),
        interval: started.interval,
      };
    },

    async poll(start) {
      let raw: unknown;
      try {
        raw = await call("POST", "/api/agent-links/requests/token", {
          body: { deviceCode: start.secret },
        });
      } catch (err) {
        if (err instanceof Refused && err.status === 429) return { status: "slow_down" };
        throw err;
      }
      const answer = Token.safeParse(raw);
      if (answer.success && answer.data.status !== "approved")
        return { status: answer.data.status };
      if (answer.success && answer.data.status === "approved") {
        return {
          status: "linked",
          link: { ref: answer.data.link.id, secret: answer.data.credential },
          account: account(answer.data.link),
        };
      }
      // Approved is answered once, so a credential in an answer that can't
      // otherwise be read is undone now: asking again would only say it expired.
      const credential = z.object({ credential: z.string().min(1) }).safeParse(raw);
      if (credential.success) {
        await call("DELETE", "/api/agent-link", { secret: credential.data.credential }).catch(
          () => undefined,
        );
        throw new AppLinkError("Infrawrench's answer couldn't be read, so the link was undone");
      }
      throw answer.error;
    },

    async describe(link): Promise<AppLinkDescription> {
      const info = LinkInfo.parse(await asLink(link, "GET", "/api/agent-link"));
      return {
        account: account(info),
        scopeGroups: info.scopeGroups,
        providers: info.providers.map((p) => ({ id: p.id, name: p.displayName })),
        ceiling: info.effectiveScopes,
        // An older Infrawrench doesn't say; then every scope is taken to be one.
        narrowable: info.narrowableScopes ?? null,
      };
    },

    async grant(link, request) {
      const body = {
        externalId: request.externalId,
        label: request.label.slice(0, 80),
        scopes: request.scopes,
        ...(request.providers.length > 0 ? { providers: request.providers } : {}),
      };
      let made: z.infer<typeof Made>;
      try {
        made = Made.parse(await asLink(link, "POST", "/api/agent-link/agents", body));
      } catch (err) {
        // An agent this server made for it before, and lost track of (say
        // it was turned off while Infrawrench couldn't be reached): nobody
        // holds its credential any more, so it's revoked to make way.
        const existing =
          err instanceof Refused && err.code === "exists"
            ? z.object({ agentId: z.string() }).safeParse(err.body)
            : null;
        if (!existing?.success) refusal(err, request.providers.length > 0);
        await asLink(link, "DELETE", agentPath(existing.data.agentId)).catch((e: unknown) => {
          if (!(e instanceof Refused && e.status === 404)) throw e;
        });
        try {
          made = Made.parse(await asLink(link, "POST", "/api/agent-link/agents", body));
        } catch (again) {
          refusal(again, request.providers.length > 0);
        }
      }
      return {
        ref: made.agent.id,
        secret: made.credential,
        scopes: made.agent.scopes,
        providers: made.agent.providers ?? [],
      };
    },

    async update(link, grant, request) {
      let agent: z.infer<typeof Agent>;
      try {
        ({ agent } = z
          .object({ agent: Agent })
          .parse(await asAgent(link, "PATCH", agentPath(grant.ref), request)));
      } catch (err) {
        refusal(err, (request.providers ?? []).length > 0);
      }
      if (agent.revokedAt) {
        throw new AppLinkRevokedError("grant", "Infrawrench says this agent was revoked");
      }
      return { scopes: agent.scopes, providers: agent.providers ?? [] };
    },

    async revoke(link, grant) {
      try {
        await asAgent(link, "DELETE", agentPath(grant.ref));
      } catch (err) {
        if (err instanceof AppLinkRevokedError && err.what === "grant") return;
        throw err;
      }
    },

    async unlink(link) {
      try {
        await asLink(link, "DELETE", "/api/agent-link");
      } catch (err) {
        if (err instanceof AppLinkRevokedError) return;
        throw err;
      }
    },

    async inspect(link) {
      const info = LinkInfo.parse(await asLink(link, "GET", "/api/agent-link"));
      const agents = z.array(Agent).parse(await asLink(link, "GET", "/api/agent-link/agents"));
      return {
        account: account(info),
        live: agents.filter((a) => !a.revokedAt).map((a) => a.id),
      };
    },

    async adopt(secret) {
      let info: LinkInfo;
      try {
        info = LinkInfo.parse(await asLink({ ref: "", secret }, "GET", "/api/agent-link"));
      } catch (err) {
        if (err instanceof AppLinkRevokedError) {
          throw new AppLinkError("Infrawrench doesn't take that link's credential");
        }
        throw err;
      }
      return { link: { ref: info.id, secret }, account: account(info) };
    },

    connection(grant) {
      return {
        mcp: { url: `${base}/api/mcp`, headers: { authorization: `Bearer ${grant.secret}` } },
        prompt: PROMPT,
      };
    },
  };
}

const URL_FIELD = defineField("url", "Infrawrench URL", {
  default: INFRAWRENCH_URL,
  placeholder: INFRAWRENCH_URL,
  hint: "Only to link a self-hosted Infrawrench.",
});

export const infrawrench = defineAppLinkFactory({
  id: "infrawrench",
  name: "Infrawrench",
  description:
    "Give nibblets their own agents in an Infrawrench organisation, each with only the scopes you tick.",
  icon: INFRAWRENCH_ICON,
  fields: [URL_FIELD],
  grants: "app",
  create(settings, deps) {
    const url = settings[URL_FIELD.key]?.trim() || INFRAWRENCH_URL;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppLinkError(`${URL_FIELD.label} isn't a URL`);
    }
    // Plain http only for one on this computer, since credentials go over it.
    const local = ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(
      parsed.hostname,
    );
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      throw new AppLinkError(`${URL_FIELD.label} should be an https URL`);
    }
    return infrawrenchPlugin({ url: `${parsed.origin}${parsed.pathname}` }, deps);
  },
});
