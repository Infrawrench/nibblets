import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  contract,
  createDispatcher,
  RunnerToServer,
  TerminalInput,
  type LiveMessage,
  type TerminalEvent,
} from "@nibblet/protocol";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import WebSocket from "ws";
import { z } from "zod";
import type { Bus } from "./bus.ts";
import type { RunnerLink } from "./conductor.ts";
import { createHandlers, type Services } from "./handlers.ts";
import { hostMcpHandler } from "./hostmcp.ts";
import { mountGuard } from "./guard.ts";
import { mcpHandler } from "./mcp.ts";
import { mountFiles } from "./files.ts";
import { viewToken } from "./store.ts";

const TICKET_TTL_MS = 30_000;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Well inside Cloudflare's 100-second idle limit, and the browser's 75-second watchdog. */
const LIVE_KEEPALIVE_MS = 25_000;

export function createApp(services: Services, bus: Bus) {
  const { config, store, conductor } = services;
  const dispatch = createDispatcher(contract, createHandlers(services));
  const tickets = new Map<string, number>();

  const bearer = (c: Context): string => {
    const header = c.req.header("authorization") ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  };

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

  const app = new Hono();

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
  // Nibblets Connect's UI checks which route to a server answers before using it.
  app.use("/healthz", cors({ origin: "*", maxAge: 600 }));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/api/pair", async (c) => {
    const body = z
      .object({ code: z.string(), label: z.string().max(100).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success || !(await store.redeemPairingCode(body.data.code))) {
      return c.json({ error: "That pairing link has expired or was already used" }, 401);
    }
    const token = await store.issueAuthToken(body.data.label ?? "Browser");
    return c.json({ token });
  });

  app.post("/api/ticket", requireUser, (c) => {
    const now = Date.now();
    for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, now + TICKET_TTL_MS);
    return c.json({ ticket });
  });

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

  app.get(
    "/api/live",
    requireTicket,
    upgradeWebSocket(() => {
      let unsubscribe: (() => void) | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      return {
        onOpen(_event, ws) {
          unsubscribe = bus.subscribe((message: LiveMessage) => ws.send(JSON.stringify(message)));
          // Tunnels and proxies close sockets that go quiet (Cloudflare's after
          // 100 seconds), and the browser uses this to spot a dead one.
          keepalive = setInterval(() => ws.send("ping"), LIVE_KEEPALIVE_MS);
        },
        onClose() {
          unsubscribe?.();
          if (keepalive) clearInterval(keepalive);
        },
      };
    }),
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
      return {
        onOpen(_event, ws) {
          socket = ws;
          void conductor.attach(nibbletId, link);
        },
        onMessage(event) {
          const parsed = RunnerToServer.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success) {
            console.warn(`bad message from runner ${nibbletId}`, parsed.error.message);
            return;
          }
          void conductor
            .onRunnerMessage(nibbletId, parsed.data)
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

  app.all("/mcp", mcpHandler(services));
  app.all("/hostmcp/:name", hostMcpHandler(services));

  // A terminal in the nibblet's container, as its agent's user, carried over the runner's socket.
  app.get(
    "/api/nibblets/:id/terminal",
    requireTicket,
    upgradeWebSocket((c) => {
      const nibbletId = c.req.param("id") ?? "";
      const size = (name: string, fallback: number) => {
        const n = Number(c.req.query(name));
        return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
      };
      const taskId = c.req.query("task") || null;
      let terminalId: string | null = null;
      return {
        onOpen(_event, ws) {
          const send = (event: TerminalEvent) => ws.send(JSON.stringify(event));
          terminalId = conductor.terminals.openTerminal(
            nibbletId,
            { cols: size("cols", 80), rows: size("rows", 24) },
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
    }),
  );

  // OpenComputerUse's view server inside the container: the live browser and taking control.
  app.get("/api/nibblets/:id/computer/*", async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return next();
    return requireTicket(c, async () => {
      const id = c.req.param("id") ?? "";
      const row = await store.nibbletRow(id).catch(() => null);
      if (!row) return;
      const path = c.req.path.slice(`/api/nibblets/${id}/computer`.length);
      // A sub-agent's browser is beside its parent's, in its parent's container.
      const address = conductor.browserAddress(id, row.parentId);
      if (!address) return;
      const upstreamUrl = `ws://${address}${path}${new URL(c.req.url).search.replace(/([?&])ticket=[^&]*&?/, "$1")}`;
      const token = viewToken(config.NIBBLET_OWNER_TOKEN, id, row.tokenHash);
      const handler = upgradeWebSocket(() => {
        let upstream: WebSocket | null = null;
        const pending: (string | Buffer)[] = [];
        return {
          onOpen(_event, ws) {
            upstream = new WebSocket(upstreamUrl, {
              headers: { authorization: `Bearer ${token}` },
            });
            upstream.on("open", () => {
              for (const m of pending.splice(0)) upstream?.send(m);
            });
            upstream.on("message", (data, isBinary) => {
              const chunk = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data);
              ws.send(isBinary ? new Uint8Array(chunk) : chunk.toString("utf8"));
            });
            upstream.on("close", (code, reason) =>
              ws.close(code === 1005 ? 1000 : code, reason.toString()),
            );
            upstream.on("error", () => ws.close(1011, "browser unavailable"));
          },
          onMessage(event) {
            const data =
              typeof event.data === "string"
                ? event.data
                : Buffer.from(event.data instanceof ArrayBuffer ? event.data : new ArrayBuffer(0));
            if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
            else pending.push(data);
          },
          onClose() {
            upstream?.close();
          },
        };
      });
      await handler(c, next);
    });
  });

  app.all("/api/nibblets/:id/computer/*", requireUser, async (c) => {
    const id = c.req.param("id") ?? "";
    const row = await store.nibbletRow(id).catch(() => null);
    if (!row) return c.json({ error: "No such nibblet" }, 404);
    const path = c.req.path.slice(`/api/nibblets/${id}/computer`.length);
    const search = new URL(c.req.url).search;
    const token = viewToken(config.NIBBLET_OWNER_TOKEN, id, row.tokenHash);
    const address = conductor.browserAddress(id, row.parentId);
    if (!address) return c.json({ error: "The browser isn't running" }, 503);
    const res = await fetch(`http://${address}${path}${search}`, {
      method: c.req.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": c.req.header("content-type") ?? "application/json",
      },
      body:
        c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.arrayBuffer(),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res) return c.json({ error: "The browser isn't running" }, 503);
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  });

  mountFiles(app, services.files, { store, config, bus, requireUser });

  const webDist = config.NIBBLET_WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
  if (existsSync(webDist)) {
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
