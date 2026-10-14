import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  type CallToolResult,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerSpec } from "@nibblet/harness";
import { declinedMessage, needsApproval, type JsonValue, type ToolRule } from "@nibblet/protocol";
import { createServer, type Server as HttpServer } from "node:http";

export interface Decision {
  approved: boolean;
  reason: string | null;
}

export interface GateOptions {
  /** Asks the user, through the nibblet server, whether a call may go ahead. */
  ask(server: string, tool: string, input: JsonValue): Promise<Decision>;
  /** The current rules; read on every call, so changes apply without a restart. */
  rules(): readonly ToolRule[];
  log(message: string): void;
  /** Where to listen on loopback; any free port when left out. */
  port?: number;
  /** `POST /refresh`: the runner saying the settings changed. */
  onRefresh?(): Promise<void>;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>> | CallToolResult;

/** How long a forwarded call may run upstream (a browser action can be slow). */
const CALL_TIMEOUT_MS = 30 * 60_000;

/** One upstream MCP server, connected on first use and kept open. */
class Upstream {
  private client: Promise<Client> | null = null;
  readonly name: string;
  private readonly spec: McpServerSpec;
  /** Identifies the definition, so a changed server is reconnected. */
  readonly key: string;

  constructor(name: string, spec: McpServerSpec) {
    this.name = name;
    this.spec = spec;
    this.key = JSON.stringify(spec);
  }

  get(): Promise<Client> {
    this.client ??= this.connect().catch((err: unknown) => {
      this.client = null;
      throw err;
    });
    return this.client;
  }

  private async connect(): Promise<Client> {
    const client = new Client({ name: "nibblet-gate", version: "0.1.0" });
    const transport =
      this.spec.type === "http"
        ? new StreamableHTTPClientTransport(new URL(this.spec.url), {
            requestInit: { headers: this.spec.headers },
          })
        : new StdioClientTransport({
            command: this.spec.command,
            args: this.spec.args,
            env: { ...stringEnv(process.env), ...this.spec.env },
          });
    client.onclose = () => {
      this.client = null;
    };
    await client.connect(transport);
    return client;
  }

  async close(): Promise<void> {
    const client = await this.client?.catch(() => null);
    this.client = null;
    await client?.close().catch(() => {});
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * Sits between the harness and the MCP servers a nibblet brings itself (and
 * the browser), so "ask me first" doesn't depend on the harness cooperating:
 * the harness only ever sees the gate. Everything is forwarded unchanged,
 * except that a `tools/call` matching a rule waits for the user, and a
 * declined one comes back as an error result the agent can read.
 */
export class McpGate {
  private readonly upstreams = new Map<string, Upstream>();
  private readonly opts: GateOptions;
  private http: HttpServer | null = null;
  private port = 0;

  constructor(opts: GateOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const http = createServer((req, res) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/refresh") {
          // Harmless to anyone who can reach it: the settings come from the server.
          await this.opts.onRefresh?.();
          res.writeHead(204).end();
          return;
        }
        const match = /^\/mcp\/([^/?]+)/.exec(req.url ?? "");
        const up = match?.[1] ? this.upstreams.get(decodeURIComponent(match[1])) : undefined;
        if (!up) {
          res
            .writeHead(404, { "content-type": "application/json" })
            .end('{"error":"no such server"}');
          return;
        }
        let client: Client;
        try {
          client = await up.get();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.log(`MCP server ${up.name} didn't start: ${message}`);
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: message }));
          return;
        }
        const server = this.proxy(up.name, client);
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
        this.opts.log(`gate request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500).end();
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    const address = http.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    this.http = http;
  }

  /** Puts a server behind the gate and returns what the harness should connect to instead. */
  wrap(name: string, spec: McpServerSpec): McpServerSpec {
    const existing = this.upstreams.get(name);
    if (!existing || existing.key !== JSON.stringify(spec)) {
      void existing?.close();
      this.upstreams.set(name, new Upstream(name, spec));
    }
    return { type: "http", url: this.urlFor(name), headers: {} };
  }

  /** Puts exactly these servers behind the gate, closing any that went or changed. */
  sync(specs: Record<string, McpServerSpec>): void {
    for (const [name, upstream] of this.upstreams) {
      if (!(name in specs)) {
        void upstream.close();
        this.upstreams.delete(name);
      }
    }
    for (const [name, spec] of Object.entries(specs)) this.wrap(name, spec);
  }

  /** The address a server behind the gate is reached at. */
  urlFor(name: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(name)}`;
  }

  async close(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((u) => u.close()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  /** Decides one call: forward it, or answer for it when the user said no. */
  async call(
    name: string,
    client: Client,
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<ToolResult> {
    if (needsApproval(this.opts.rules(), name, params.name)) {
      const input: JsonValue = JSON.parse(JSON.stringify(params.arguments ?? {}));
      const decision = await this.opts.ask(name, params.name, input);
      if (!decision.approved) {
        return {
          content: [{ type: "text", text: declinedMessage(decision.reason) }],
          isError: true,
        };
      }
    }
    return client.callTool(params, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
  }

  private proxy(name: string, client: Client): Server {
    const upstream = client.getServerCapabilities() ?? {};
    const capabilities: ServerCapabilities = {};
    if (upstream.tools) capabilities.tools = {};
    if (upstream.resources) capabilities.resources = {};
    if (upstream.prompts) capabilities.prompts = {};
    const server = new Server({ name: `gate:${name}`, version: "0.1.0" }, { capabilities });
    if (upstream.tools) {
      server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
      server.setRequestHandler(CallToolRequestSchema, (req) => this.call(name, client, req.params));
    }
    if (upstream.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, (req) =>
        client.listResources(req.params),
      );
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
}
