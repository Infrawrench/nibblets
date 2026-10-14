import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerSpec, TurnAttachment } from "@nibblet/harness";
import type { FileRef } from "@nibblet/protocol";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

export function guessMime(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** `name.ext`, then `name (2).ext`, `name (3).ext`… for names already used. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface RunnerFilesOptions {
  /** The nibblet server, e.g. `http://server:8420`. */
  serverUrl: string;
  token: string;
  workdir: string;
  /** The turn a shared file belongs to, so the UI places it in that turn. */
  currentTurn: () => string | null;
}

/**
 * Files between the nibblet server and this container: the user's
 * attachments come down into `uploads/` before a turn, and `share_file`
 * sends one of the nibblet's files up to the user.
 */
export class RunnerFiles {
  private readonly opts: RunnerFilesOptions;
  private http: HttpServer | null = null;

  constructor(opts: RunnerFilesOptions) {
    this.opts = opts;
  }

  private get auth() {
    return { authorization: `Bearer ${this.opts.token}` };
  }

  /** Downloads a turn's attachments into `uploads/`, giving each a unique name. */
  async fetch(refs: FileRef[]): Promise<TurnAttachment[]> {
    if (refs.length === 0) return [];
    const dir = join(this.opts.workdir, "uploads");
    await mkdir(dir, { recursive: true });
    const taken = new Set<string>();
    const out: TurnAttachment[] = [];
    for (const ref of refs) {
      const name = uniqueName(basename(ref.name), taken);
      taken.add(name);
      const res = await fetch(
        `${this.opts.serverUrl}/runner/files/${encodeURIComponent(ref.fileId)}`,
        {
          headers: this.auth,
        },
      );
      if (!res.ok || !res.body) throw new Error(`Couldn't fetch ${ref.name} (${res.status})`);
      const path = join(dir, name);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
      out.push({ path, name, mime: ref.mime, size: ref.size });
    }
    return out;
  }

  /** Shares a file with the user: asks for an upload slot, then streams it there. */
  async share(path: string, name?: string, caption?: string): Promise<string> {
    const full = isAbsolute(path) ? path : resolve(this.opts.workdir, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new Error(`No file at ${path}`);
    const fileName = name?.trim() || basename(full);
    const slot = await fetch(`${this.opts.serverUrl}/runner/files`, {
      method: "POST",
      headers: { ...this.auth, "content-type": "application/json" },
      body: JSON.stringify({
        name: fileName,
        mime: guessMime(fileName),
        size: info.size,
        caption: caption?.trim() || null,
        turnId: this.opts.currentTurn(),
      }),
    });
    const body = Slot.safeParse(await slot.json().catch(() => null));
    if (!slot.ok || !body.success)
      throw new Error(`The server wouldn't take ${fileName} (${slot.status})`);
    const upload = await fetch(`${this.opts.serverUrl}${body.data.url}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(info.size) },
      body: Readable.toWeb(createReadStream(full)),
      duplex: "half",
    });
    if (!upload.ok) {
      const reason = await upload.text().catch(() => "");
      throw new Error(`Uploading ${fileName} failed: ${reason || upload.status}`);
    }
    return `Shared ${fileName} with the user.`;
  }

  /** A local MCP server with `share_file`, for the harness to call. */
  async startMcp(): Promise<McpServerSpec> {
    const http = createServer((req, res) => {
      const server = new McpServer({ name: "files", version: "0.1.0" });
      server.registerTool(
        "share_file",
        {
          description:
            "Send a file from your workspace to the user. It shows up in the chat for them to open or download. Use it for anything you made for them: reports, exports, images, archives.",
          inputSchema: {
            path: z
              .string()
              .describe("Path to the file, absolute or relative to your working directory"),
            name: z.string().optional().describe("What to call it, if not its file name"),
            caption: z.string().max(500).optional().describe("A line about what it is"),
          },
        },
        async ({ path, name, caption }) => {
          try {
            return { content: [{ type: "text", text: await this.share(path, name, caption) }] };
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text }], isError: true };
          }
        },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    this.http = http;
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", () => done()));
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} };
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => (this.http ? this.http.close(() => done()) : done()));
  }
}

const Slot = z.object({ fileId: z.string(), url: z.string().startsWith("/") });
