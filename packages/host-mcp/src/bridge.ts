import { createHash } from "node:crypto";
import { z } from "zod";
import { mcpTarget } from "@nibblet/protocol";
import { detectOpencode, readOpencodeLogin } from "./opencode.ts";
import { detectKimi, readKimiLogin } from "./kimi.ts";
import { setTailscaleServe, tailscaleLogin, tailscaleState } from "./tailscale.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { basename, dirname } from "node:path";
import {
  defaultSources,
  loadServers,
  serverEnv,
  type ConfigSource,
  type HostServer,
} from "./config.ts";
import {
  defaultTokenStore,
  GrantRequest,
  onePasswordStatus,
  OnePasswordGrantsManager,
} from "./onepassword.ts";
import { cliPlugins, runOnHost, type CliPlugin, type Run } from "./clis/index.ts";
import type { AppUpdaterHost } from "./update.ts";
import type { HostMachines } from "@nibblet/machine/host";
import { Writable } from "node:stream";
import { borrowProfile, detectHostChrome, onePasswordExtensionDir } from "./browser.ts";

export interface ServerStatus {
  name: string;
  source: string;
  transport: "stdio" | "http" | "sse";
  status: "idle" | "ready" | "starting" | "error";
  fingerprint: string;
  detail: string | null;
  tools: { name: string; description: string | null }[];
}

const MAX_BACKOFF_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * One host MCP server, connected on first use and kept open. When it dies
 * it's reconnected on the next use, no sooner than its backoff allows.
 */
class Upstream {
  readonly server: HostServer;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private status: ServerStatus["status"] = "idle";
  private detail: string | null = null;
  private tools: ServerStatus["tools"] = [];
  private failures = 0;
  private retryAt = 0;
  private closed = false;

  constructor(server: HostServer) {
    this.server = server;
  }

  get transport(): ServerStatus["transport"] {
    const def = this.server.def;
    return "command" in def ? "stdio" : def.type;
  }

  describe(): ServerStatus {
    return {
      name: this.server.name,
      source: this.server.source,
      transport: this.transport,
      status: this.status,
      detail: this.detail,
      tools: this.tools,
      fingerprint: createHash("sha256").update(mcpTarget(this.server.def)).digest("hex"),
    };
  }

  async get(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const wait = this.retryAt - Date.now();
    if (wait > 0)
      throw new Error(
        `${this.server.name} failed recently; retrying in ${Math.ceil(wait / 1000)}s`,
      );
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    this.status = "starting";
    const def = this.server.def;
    const client = new Client({ name: "nibblet-host-bridge", version: "0.1.0" });
    const transport =
      "command" in def
        ? new StdioClientTransport({
            command: def.command,
            args: def.args,
            env: serverEnv(def),
            stderr: "ignore",
          })
        : def.type === "http"
          ? new StreamableHTTPClientTransport(new URL(def.url), {
              requestInit: { headers: def.headers },
            })
          : new SSEClientTransport(new URL(def.url), { requestInit: { headers: def.headers } });
    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `${this.server.name} didn't start`,
      );
      const caps = client.getServerCapabilities();
      this.tools = caps?.tools
        ? (await client.listTools()).tools.map((t) => ({
            name: t.name,
            description: t.description ?? null,
          }))
        : [];
    } catch (err) {
      this.fail(err);
      await client.close().catch(() => {});
      throw err;
    }
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.closed) this.fail(new Error("It stopped"));
    };
    this.client = client;
    this.failures = 0;
    this.status = "ready";
    this.detail = null;
    return client;
  }

  private fail(err: unknown): void {
    this.failures++;
    this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
    this.status = "error";
    this.detail = err instanceof Error ? err.message : String(err);
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** An MCP server that forwards everything to one upstream client. */
function proxyServer(name: string, client: Client): Server {
  const upstream = client.getServerCapabilities() ?? {};
  const capabilities: ServerCapabilities = {};
  if (upstream.tools) capabilities.tools = {};
  if (upstream.resources) capabilities.resources = {};
  if (upstream.prompts) capabilities.prompts = {};
  const server = new Server({ name: `host:${name}`, version: "0.1.0" }, { capabilities });
  if (upstream.tools) {
    server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
    server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params));
  }
  if (upstream.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) =>
      client.listResourceTemplates(req.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));
  }
  if (upstream.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req) => client.listPrompts(req.params));
    server.setRequestHandler(GetPromptRequestSchema, (req) => client.getPrompt(req.params));
  }
  return server;
}

export interface BridgeOptions {
  port: number;
  /** 127.0.0.1 by default; Docker Desktop and OrbStack reach it as host.docker.internal. */
  host?: string;
  token: string;
  configPaths?: ConfigSource[];
  log?: (message: string) => void;
  /** CLIs whose logins can be shared; every built-in plugin by default. */
  clis?: readonly CliPlugin[];
  /** How CLIs are run; swapped in tests. */
  run?: Run;
  /** What `tailscale serve` shares: the nibblet server as the host sees it. */
  serveTarget?: string;
  /** Per-nibblet 1Password access; swapped in tests. */
  onePassword?: OnePasswordGrantsManager;
  /** How this host installs a new Nibblets; without one, it can't. */
  updater?: AppUpdaterHost;
  /** The host's hypervisors, for nibblets in virtual machines; without them, there are none. */
  machines?: HostMachines;
}

export interface HostMcpBridge {
  readonly port: number;
  servers(): Promise<ServerStatus[]>;
  close(): Promise<void>;
}

/**
 * Serves the host's MCP servers to nibblets: each at `/mcp/<name>` as a
 * streamable HTTP MCP server, plus `GET /servers`. Every request needs the
 * bridge token. Config files are watched, so edits apply without a restart.
 */
export async function startHostMcpBridge(opts: BridgeOptions): Promise<HostMcpBridge> {
  const sources = opts.configPaths ?? defaultSources();
  const log = opts.log ?? (() => {});
  const upstreams = new Map<string, Upstream>();
  const clis = opts.clis ?? cliPlugins;
  const run = opts.run ?? runOnHost;
  const serveTarget = opts.serveTarget ?? "http://127.0.0.1:8420";
  const onePassword = opts.onePassword ?? new OnePasswordGrantsManager(run, defaultTokenStore());

  const reload = async (): Promise<void> => {
    const next = await loadServers(sources);
    for (const [name, up] of upstreams) {
      const def = next.get(name);
      if (!def || JSON.stringify(def) !== JSON.stringify(up.server)) {
        upstreams.delete(name);
        void up.close();
      }
    }
    for (const [name, server] of next)
      if (!upstreams.has(name)) upstreams.set(name, new Upstream(server));
    log(`host MCP servers: ${[...upstreams.keys()].join(", ") || "none"}`);
  };
  await reload();

  // Watch directories rather than files: a config created later still counts.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const watchers: FSWatcher[] = [];
  for (const dir of new Set(sources.map((s) => dirname(s.path)))) {
    const names = new Set(
      sources.filter((s) => dirname(s.path) === dir).map((s) => basename(s.path)),
    );
    try {
      watchers.push(
        watch(dir, (_event, file) => {
          if (file && !names.has(file.toString())) return;
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => void reload(), 300);
        }),
      );
    } catch {
      // The directory doesn't exist yet; that source just stays empty.
    }
  }

  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorised = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return (
      opts.token.length > 0 && got.length === expected.length && timingSafeEqual(got, expected)
    );
  };

  // Only describes: a server starts when a nibblet first calls it, so opening
  // a list of host tools never launches every MCP server on the machine.
  const describeAll = async (): Promise<ServerStatus[]> =>
    [...upstreams.values()].map((u) => u.describe());

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const http: HttpServer = createServer((req, res) => {
    void (async () => {
      if (!authorised(req)) return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://bridge");
      if (url.pathname === "/machines" || url.pathname.startsWith("/machines/")) {
        if (!opts.machines) return json(res, 200, { hypervisors: [] });
        return opts.machines.handle(req, res, url.pathname);
      }
      if (req.method === "GET" && url.pathname === "/servers")
        return json(res, 200, await describeAll());
      if (req.method === "GET" && url.pathname === "/clis") {
        return json(res, 200, await Promise.all(clis.map((p) => p.detect(run))));
      }
      if (url.pathname === "/tailscale/login" && req.method === "POST") {
        return json(res, 200, await tailscaleLogin(run, serveTarget));
      }
      if (url.pathname === "/tailscale" && (req.method === "GET" || req.method === "POST")) {
        if (req.method === "GET") return json(res, 200, await tailscaleState(run, serveTarget));
        const body = z.object({ serving: z.boolean() }).safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "Send { serving: boolean }" });
        return json(res, 200, await setTailscaleServe(run, serveTarget, body.data.serving));
      }
      if (url.pathname === "/update" && req.method === "GET") {
        return json(
          res,
          200,
          opts.updater
            ? await opts.updater.describe()
            : { method: "manual", updating: false, error: null },
        );
      }
      if (url.pathname === "/update" && req.method === "POST") {
        const body = z.object({ version: z.string() }).safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "Send { version }" });
        if (!opts.updater) return json(res, 409, { error: "This computer can't update itself" });
        try {
          await opts.updater.apply(body.data.version);
          return json(res, 202, await opts.updater.describe());
        } catch (err) {
          return json(res, 409, { error: err instanceof Error ? err.message : "Couldn't update" });
        }
      }
      if (req.method === "GET" && url.pathname === "/harness/opencode") {
        return json(res, 200, await detectOpencode(run));
      }
      if (req.method === "GET" && url.pathname === "/harness/opencode/login") {
        return json(res, 200, await readOpencodeLogin());
      }
      if (req.method === "GET" && url.pathname === "/harness/kimi") {
        return json(res, 200, await detectKimi(run));
      }
      if (req.method === "GET" && url.pathname === "/harness/kimi/login") {
        return json(res, 200, await readKimiLogin());
      }
      if (req.method === "GET" && url.pathname === "/1password") {
        return json(res, 200, await onePasswordStatus(run));
      }
      // Whether this computer can open a borrowed profile, and whether 1Password is here to add.
      if (req.method === "GET" && url.pathname === "/browser") {
        const chrome = await detectHostChrome();
        return json(res, 200, {
          chrome: chrome !== null,
          onePassword: (await onePasswordExtensionDir()) !== null,
        });
      }
      // Opens a nibblet's profile (the gzipped tar in the body) in a Chrome
      // window here; when it closes, streams the cleaned profile back. The
      // request stays open for as long as the window is.
      if (req.method === "POST" && url.pathname === "/browser/borrow") {
        const controller = new AbortController();
        res.on("close", () => {
          // The server dropped the request (an early "end"): stop the window, no handback.
          if (!res.writableEnded) controller.abort();
        });
        // The handed-back tar is the response body; its head waits until the
        // window closes, so a failure before then can still be a JSON error.
        let started = false;
        const out = new Writable({
          write(chunk: Buffer, _enc, done) {
            if (!started) {
              started = true;
              res.writeHead(200, { "content-type": "application/gzip" });
            }
            res.write(chunk) ? done() : res.once("drain", done);
          },
          final(done) {
            res.end(() => done());
          },
        });
        try {
          await borrowProfile({
            profileTar: req,
            out,
            userAgent: url.searchParams.get("ua"),
            proxy: url.searchParams.get("proxy"),
            wantOnePassword: url.searchParams.get("onepassword") === "1",
            signal: controller.signal,
            log,
          });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent && !started) return json(res, 409, { error: message });
          if (!res.writableEnded) res.end();
          return;
        }
      }
      const op = /^\/1password\/(grants|token)\/([\w-]+)$/.exec(url.pathname);
      if (op?.[1] === "grants" && op[2] && req.method === "PUT") {
        const body = GrantRequest.safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "Send { label, grants }" });
        try {
          await onePassword.grant(op[2], body.data.label, body.data.grants);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 409, { error: err instanceof Error ? err.message : "Couldn't share" });
        }
      }
      if (op?.[1] === "grants" && op[2] && req.method === "DELETE") {
        await onePassword.grant(op[2], "unused", []);
        return json(res, 200, { ok: true });
      }
      if (op?.[1] === "token" && op[2] && req.method === "GET") {
        const found = await onePassword.token(op[2]);
        return found ? json(res, 200, found) : json(res, 404, { error: "Nothing shared" });
      }
      const cli = /^\/clis\/([^/]+)\/credential$/.exec(url.pathname);
      if (req.method === "GET" && cli) {
        const plugin = clis.find((p) => p.id === cli[1]);
        if (!plugin) return json(res, 404, { error: "No such CLI" });
        try {
          return json(res, 200, await plugin.credential(run));
        } catch (err) {
          // The message is ours, never the CLI's output, so no token can leak into it.
          return json(res, 409, { error: err instanceof Error ? err.message : "Not signed in" });
        }
      }
      const match = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
      const up = match?.[1] ? upstreams.get(decodeURIComponent(match[1])) : undefined;
      if (!up) return json(res, 404, { error: "No such host MCP server" });
      let client: Client;
      try {
        client = await up.get();
      } catch (err) {
        return json(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      const server = proxyServer(up.server.name, client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 500, { error: "internal" });
      else res.end();
    });
  });

  // A VM's agent port, as a WebSocket for the server.
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://bridge").pathname;
    if (!authorised(req) || !opts.machines?.upgrade(req, socket, head, path)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    servers: describeAll,
    async close() {
      for (const w of watchers) w.close();
      if (pending) clearTimeout(pending);
      await Promise.all([...upstreams.values()].map((u) => u.close()));
      opts.machines?.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
