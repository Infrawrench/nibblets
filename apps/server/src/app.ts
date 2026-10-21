import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  contract,
  createDispatcher,
  HttpError,
  LiveMessage,
  RpcErrorCode,
  RunnerToServer,
  TerminalEvent,
  TerminalInput,
} from "@nibblet/protocol";
import { openApiDocument } from "@nibblet/protocol/openapi";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import WebSocket from "ws";
import { z } from "zod";
import { bearerToken, safeEqual } from "./auth.ts";
import type { Bus } from "./bus.ts";
import type { RunnerLink } from "./conductor.ts";
import { createHandlers, type Services } from "./handlers.ts";
import { Routes, type Auth } from "./http.ts";
import { hostMcpHandler } from "./hostmcp.ts";
import { mountBudgets } from "./budget.ts";
import { purchasePath } from "./banks.ts";
import { mountGuard } from "./guard.ts";
import { mcpHandler } from "./mcp.ts";
import { mountFiles } from "./files.ts";
import { viewToken } from "./store.ts";

const TICKET_TTL_MS = 30_000;

/** Well inside Cloudflare's 100-second idle limit, and the browser's 75-second watchdog. */
const LIVE_KEEPALIVE_MS = 25_000;

export function createApp(services: Services, bus: Bus) {
  const { config, store, conductor } = services;
  const dispatch = createDispatcher(contract, createHandlers(services));
  const tickets = new Map<string, number>();

  const bearer = (c: Context): string => bearerToken(c.req.header("authorization"));

  /**
   * The owner token, a paired device's token, or a short-lived token Nibblets
   * Connect minted for the account this server is linked to.
   */
  const signedIn = async (token: string): Promise<boolean> =>
    token.length > 0 &&
    (safeEqual(token, config.NIBBLET_OWNER_TOKEN) ||
      (await store.checkAuthToken(token)) ||
      (await services.connect.verify(token)) !== null);

  const requireUser = async (c: Context, next: Next) => {
    if (!(await signedIn(bearer(c))))
      return c.json({ ok: false, error: { code: "unauthorized", message: "Sign in first" } }, 401);
    await next();
  };

  /** WebSockets can't send headers from a browser, so they present a short-lived ticket. */
  const requireTicket = async (c: Context, next: Next) => {
    const ticket = c.req.query("ticket") ?? "";
    const expires = tickets.get(ticket);
    tickets.delete(ticket);
    if (!expires || expires < Date.now()) return c.text("Unauthorized", 401);
    await next();
  };

  const signedOut = {
    description: "Not signed in.",
    body: z.object({
      ok: z.literal(false),
      error: z.object({ code: RpcErrorCode, message: z.string() }),
    }),
  };
  const auth = {
    anyone: { security: [] },
    user: { check: requireUser, security: [{ bearer: [] }], rejects: signedOut },
    ticket: {
      check: requireTicket,
      security: [{ ticket: [] }],
      rejects: { description: "No ticket, or it has expired." },
    },
  } satisfies Record<string, Auth>;

  const app = new Hono();
  const routes = new Routes(app);

  // Nibblets Connect, open in the desktop app, reaches the app's own server on
  // 127.0.0.1; the browser asks first whether a public page may.
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-private-network")) {
      c.res.headers.set("access-control-allow-private-network", "true");
    }
  });
  // Peers' UIs call this server from their own origin, with bearer tokens rather than cookies.
  app.use(
    "/api/*",
    cors({ origin: "*", allowHeaders: ["authorization", "content-type"], maxAge: 600 }),
  );
  // Gzip what goes to people: transcripts and lists are large and repetitive
  // JSON, and they often come over a tunnel or a phone's connection. Runner,
  // guard and MCP traffic stays on the host and is left alone.
  app.use("/api/*", compress());
  // Nibblets Connect's UI checks which route to a server answers before using it.
  app.use("/healthz", cors({ origin: "*", maxAge: 600 }));

  routes.get(
    "/healthz",
    {
      summary: "Whether the server is up.",
      tags: ["server"],
      auth: auth.anyone,
      responses: { 200: { description: "It is.", body: z.object({ ok: z.literal(true) }) } },
    },
    (c) => c.json({ ok: true }),
  );

  // A card provider asking, from the internet, whether a purchase may go
  // through. No one signs in: the bank checks the provider's signature.
  app.use(
    purchasePath(":kind"),
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text("Too large", 413) }),
  );
  routes.post(
    purchasePath(":kind"),
    {
      summary: "A card provider asking whether a purchase may go through.",
      description:
        "Set up as the provider's purchase webhook (`bank.status` says where). The body and answer are in the provider's own form, and only a bank set up here whose signature checks out is answered.",
      tags: ["bank"],
      auth: auth.anyone,
      params: { kind: "The bank's plugin, such as `stripe`." },
      body: "binary",
      responses: {
        200: { description: "The bank's answer, as its provider expects it.", body: "binary" },
        400: { description: "Not signed by a bank set up here." },
        413: { description: "Larger than 256 KiB." },
      },
    },
    async (c) => {
      const answer = await services.banks.purchase(c.req.param("kind") ?? "", {
        headers: c.req.raw.headers,
        body: await c.req.text(),
      });
      if (!answer) return c.text("Not from a bank set up here", 400);
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    },
  );

  // What the API looks like is no secret: the source is public. Built on the
  // first request, once every route is mounted.
  let openapi: ReturnType<typeof openApiDocument> | null = null;
  routes.get(
    "/api/openapi.json",
    {
      summary: "This description of the API.",
      tags: ["server"],
      auth: auth.anyone,
      responses: { 200: { description: "An OpenAPI 3.1 document." } },
    },
    (c) =>
      c.json(
        (openapi ??= openApiDocument({ version: services.version, routes: routes.described })),
      ),
  );

  routes.post(
    "/api/pair",
    {
      summary: "Trades a pairing link's code for a token to sign in with.",
      description:
        "`auth.createPairingLink` (or `cli.ts pair`) makes the link; its code works once.",
      tags: ["auth"],
      auth: auth.anyone,
      body: z.object({
        code: z.string(),
        label: z.string().max(100).optional().describe("What to call this device."),
      }),
      responses: {
        200: { description: "A bearer token.", body: z.object({ token: z.string() }) },
        401: { description: "The code has expired or was already used.", body: HttpError },
      },
    },
    async (c, { body }) => {
      if (!(await store.redeemPairingCode(body.code))) {
        return c.json({ error: "That pairing link has expired or was already used" }, 401);
      }
      const token = await store.issueAuthToken(body.label ?? "Browser");
      return c.json({ token });
    },
  );

  routes.post(
    "/api/ticket",
    {
      summary: "A one-time ticket to open a WebSocket with, good for 30 seconds.",
      tags: ["auth"],
      auth: auth.user,
      responses: { 200: { description: "The ticket.", body: z.object({ ticket: z.string() }) } },
    },
    (c) => {
      const now = Date.now();
      for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
      const ticket = randomBytes(24).toString("base64url");
      tickets.set(ticket, now + TICKET_TTL_MS);
      return c.json({ ticket });
    },
  );

  app.post("/api/rpc/:path", requireUser, async (c) => {
    const input: unknown = await c.req.json().catch(() => ({}));
    const res = await dispatch(c.req.param("path") ?? "", input, {});
    const status = res.ok
      ? 200
      : res.error.code === "not_found"
        ? 404
        : res.error.code === "bad_request"
          ? 400
          : res.error.code === "unauthorized"
            ? 401
            : 500;
    return c.json(res, status);
  });

  const live = upgradeWebSocket(() => {
    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    return {
      onOpen(_event, ws) {
        unsubscribe = bus.subscribeUi((message: LiveMessage) =>
          ws.send(JSON.stringify(message), { compress: true }),
        );
        // Tunnels and proxies close sockets that go quiet (Cloudflare's after
        // 100 seconds), and the browser uses this to spot a dead one.
        keepalive = setInterval(() => ws.send("ping"), LIVE_KEEPALIVE_MS);
      },
      onClose() {
        unsubscribe?.();
        if (keepalive) clearInterval(keepalive);
      },
    };
  });
  routes.get(
    "/api/live",
    {
      summary: "Live updates, over a WebSocket.",
      description:
        "Each message is a `LiveMessage` as JSON, apart from a bare `ping` every 25 seconds.",
      tags: ["live"],
      auth: auth.ticket,
      responses: { 101: { description: "Switching to a WebSocket." } },
      websocket: { receive: LiveMessage },
    },
    (c, _input, next) => live(c, next),
  );

  // Runners authenticate with their nibblet's token in a header; they aren't browsers.
  app.get("/runner", async (c, next) => {
    const row = await store.nibbletByToken(bearer(c));
    if (!row) return c.text("Unauthorized", 401);
    const nibbletId = row.id;
    const handler = upgradeWebSocket(() => {
      let socket: { send(data: string): void; close(code?: number, reason?: string): void } | null =
        null;
      const link: RunnerLink = {
        send: (message) => socket?.send(JSON.stringify(message)),
        close: () => socket?.close(1000, "replaced"),
      };
      // Its messages are heard once it's taken, in order, and not at all if it's turned away.
      let taken: Promise<boolean> = Promise.resolve(false);
      return {
        onOpen(_event, ws) {
          socket = ws;
          taken = conductor.attach(nibbletId, link).catch((err: unknown) => {
            console.error(err);
            return false;
          });
        },
        onMessage(event) {
          const parsed = RunnerToServer.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success) {
            console.warn(`bad message from runner ${nibbletId}`, parsed.error.message);
            return;
          }
          void taken
            .then((ok) => (ok ? conductor.onRunnerMessage(nibbletId, parsed.data) : undefined))
            .catch((err: unknown) => console.error(err));
        },
        onClose() {
          void conductor.detach(nibbletId, link);
        },
      };
    });
    return handler(c, next);
  });

  // The guard in each nibblet's container: its settings and secrets, and approvals.
  mountGuard(app, services);

  // The credential proxy, checking and reporting nibblets' spending on API keys.
  mountBudgets(app, { config, budgets: conductor.budgets });

  app.all("/mcp", mcpHandler(services));
  app.all("/hostmcp/:name", hostMcpHandler(services));

  // A terminal in the nibblet's container, as its agent's user, carried over the runner's socket.
  const size = (fallback: number) => z.coerce.number().int().min(1).max(1000).catch(fallback);
  routes.get(
    "/api/nibblets/:id/terminal",
    {
      summary: "A terminal in the nibblet's container, over a WebSocket.",
      description:
        "Send `TerminalInput` messages and receive `TerminalEvent` ones, as JSON. The socket closes after `exit` or `error`.",
      tags: ["nibblets"],
      auth: auth.ticket,
      params: { id: "The nibblet's id." },
      query: z.object({
        cols: size(80),
        rows: size(24),
        task: z
          .string()
          .optional()
          .describe("A background task's id, to attach to its terminal rather than a new shell."),
      }),
      responses: { 101: { description: "Switching to a WebSocket." } },
      websocket: { send: TerminalInput, receive: TerminalEvent },
    },
    (c, { query }, next) =>
      upgradeWebSocket(() => {
        const nibbletId = c.req.param("id") ?? "";
        const taskId = query.task || null;
        let terminalId: string | null = null;
        return {
          onOpen(_event, ws) {
            const send = (event: TerminalEvent) =>
              ws.send(JSON.stringify(event), { compress: true });
            terminalId = conductor.terminals.openTerminal(
              nibbletId,
              { cols: query.cols, rows: query.rows },
              taskId,
              {
                output: (data) => send({ type: "output", data }),
                exit: (code) => {
                  terminalId = null;
                  send({ type: "exit", code });
                  ws.close(1000, "exited");
                },
              },
            );
            if (!terminalId) {
              send({ type: "error", message: "It's asleep. Wake it to open a terminal." });
              ws.close(1000, "not running");
            }
          },
          onMessage(event) {
            if (!terminalId) return;
            let raw: unknown;
            try {
              raw = JSON.parse(String(event.data));
            } catch {
              return;
            }
            const msg = TerminalInput.safeParse(raw);
            if (!msg.success) return;
            if (msg.data.type === "input") conductor.terminals.input(terminalId, msg.data.data);
            else if (msg.data.type === "ack") conductor.terminals.ack(terminalId, msg.data.chars);
            else conductor.terminals.resize(terminalId, msg.data);
          },
          onClose() {
            if (terminalId) conductor.terminals.close(terminalId);
          },
        };
      })(c, next),
  );

  // OpenComputerUse's view servers inside the container, live, and taking
  // control: the browser (the guard's) and the desktop with the other apps
  // (the agent's). Each resolves to an address and the token it takes, or
  // null when it isn't running.
  const views: Record<
    string,
    { what: string; upstream: (id: string) => Promise<{ address: string; token: string } | null> }
  > = {
    computer: {
      what: "browser",
      upstream: async (id) => {
        const row = await store.nibbletRow(id);
        // A sub-agent's browser is beside its parent's, in its parent's container.
        const address = await conductor.browserAddress(id, row.parentId);
        if (!address) return null;
        return { address, token: viewToken(config.NIBBLET_OWNER_TOKEN, id, row.tokenHash) };
      },
    },
    desktop: { what: "desktop", upstream: (id) => conductor.desktop(id) },
  };
  for (const [segment, view] of Object.entries(views)) {
    const notRunning = `The ${view.what} isn't running`;
    app.get(`/api/nibblets/:id/${segment}/*`, async (c, next) => {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return next();
      // Every way out returns a response, the upgrade's included: Hono fails a
      // request whose handler returns nothing.
      const denied = await requireTicket(c, async () => {});
      if (denied) return denied;
      const id = c.req.param("id") ?? "";
      const upstream = await view.upstream(id).catch(() => undefined);
      if (upstream === undefined) return c.text("No such nibblet", 404);
      if (!upstream) return c.text(notRunning, 503);
      const path = c.req.path.slice(`/api/nibblets/${id}/${segment}`.length);
      const upstreamUrl = `ws://${upstream.address}${path}${new URL(c.req.url).search.replace(/([?&])ticket=[^&]*&?/, "$1")}`;
      const handler = upgradeWebSocket(() => {
        let socket: WebSocket | null = null;
        const pending: (string | Buffer)[] = [];
        return {
          onOpen(_event, ws) {
            socket = new WebSocket(upstreamUrl, {
              headers: { authorization: `Bearer ${upstream.token}` },
            });
            socket.on("open", () => {
              for (const m of pending.splice(0)) socket?.send(m);
            });
            socket.on("message", (data, isBinary) => {
              const chunk = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data);
              ws.send(isBinary ? new Uint8Array(chunk) : chunk.toString("utf8"));
            });
            socket.on("close", (code, reason) =>
              ws.close(code === 1005 ? 1000 : code, reason.toString()),
            );
            socket.on("error", () => ws.close(1011, `${view.what} unavailable`));
          },
          onMessage(event) {
            const data =
              typeof event.data === "string"
                ? event.data
                : Buffer.from(event.data instanceof ArrayBuffer ? event.data : new ArrayBuffer(0));
            if (socket?.readyState === WebSocket.OPEN) socket.send(data);
            else pending.push(data);
          },
          onClose() {
            socket?.close();
          },
        };
      });
      return handler(c, next);
    });

    app.all(`/api/nibblets/:id/${segment}/*`, requireUser, async (c) => {
      const id = c.req.param("id") ?? "";
      const upstream = await view.upstream(id).catch(() => undefined);
      if (upstream === undefined) return c.json({ error: "No such nibblet" }, 404);
      if (!upstream) return c.json({ error: notRunning }, 503);
      const path = c.req.path.slice(`/api/nibblets/${id}/${segment}`.length);
      const search = new URL(c.req.url).search;
      const res = await fetch(`http://${upstream.address}${path}${search}`, {
        method: c.req.method,
        headers: {
          authorization: `Bearer ${upstream.token}`,
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body:
          c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer(),
        // Starting an app waits for its first window.
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (!res) return c.json({ error: notRunning }, 503);
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
      });
    });
  }

  mountFiles(app, services.files, { store, config, bus, routes, user: auth.user });

  const webDist = config.NIBBLET_WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
  if (existsSync(webDist)) {
    // Only what fell through the routes above: the bundle and the app shell.
    app.use("/*", compress());
    app.use(
      "/*",
      serveStatic({
        root: webDist,
        onFound: (path, c) => {
          c.header(
            "cache-control",
            path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          );
        },
      }),
    );
    // A missing bundle is a 404, not the app shell, or a stale page fails silently.
    app.get("/assets/*", (c) => c.text("Not found", 404));
    // index.html names the hashed bundles, so it must never be served stale.
    app.get("*", async (c) => {
      c.header("cache-control", "no-cache");
      return c.html(await readFile(`${webDist}/index.html`, "utf8"));
    });
  } else {
    app.get("/", (c) => c.text("The web UI isn't built. Run `pnpm --filter @nibblet/web build`."));
  }

  return app;
}
