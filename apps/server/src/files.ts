import { files } from "@nibblets/db";
import { FileRef, HttpError, RpcError, type ThreadItem } from "@nibblets/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Bus } from "./bus.ts";
import type { Config } from "./config.ts";
import type { Auth, Routes } from "./http.ts";
import { newId, type Store } from "./store.ts";

const Limits = z.object({
  NIBBLET_MAX_FILE_MB: z.coerce.number().positive().default(100),
});

/** How long a signed download or upload link works for. */
const DOWNLOAD_TTL_MS = 60 * 60_000;
const UPLOAD_TTL_MS = 15 * 60_000;
/** Progress updates for an upload the UI is watching, at most this often. */
const PROGRESS_EVERY_MS = 300;

type FileRow = typeof files.$inferSelect;

export function toFileRef(row: FileRow): FileRef {
  return { fileId: row.id, name: row.name, mime: row.mime, size: row.size };
}

/** A name safe to keep: no path, no control characters, not empty. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return clean && clean !== "." && clean !== ".." ? clean : "file";
}

/** Shown in the browser (images, PDFs, text, video, audio); everything else downloads. */
export function inlineMime(mime: string): boolean {
  return /^(image\/(?!svg)|video\/|audio\/|text\/plain$|application\/pdf$)/.test(mime);
}

/**
 * Signed links for files, so an <img> or a runner's upload can carry its own
 * short-lived permission instead of a bearer token. The signature covers what
 * the link is for, which file, and when it stops working.
 */
export class FileSigner {
  private readonly key: string;
  constructor(key: string) {
    this.key = key;
  }

  sign(purpose: "get" | "put", fileId: string, ttlMs: number, now = Date.now()) {
    const exp = Math.floor((now + ttlMs) / 1000);
    return { exp, sig: this.mac(purpose, fileId, exp) };
  }

  verify(purpose: "get" | "put", fileId: string, exp: string, sig: string, now = Date.now()) {
    const expires = Number(exp);
    if (!Number.isInteger(expires) || expires * 1000 < now) return false;
    const expected = Buffer.from(this.mac(purpose, fileId, expires));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private mac(purpose: string, fileId: string, exp: number): string {
    return createHmac("sha256", this.key)
      .update(`file:${purpose}:${fileId}:${exp}`)
      .digest("base64url");
  }
}

interface FileDeps {
  store: Store;
  config: Config;
  bus: Bus;
  /** Mounts and describes the routes people call. */
  routes: Routes;
  /** A person (owner, paired device, Nibblets Connect). */
  user: Auth;
}

/** Files on the server: the store, the HTTP routes, and what the conductor needs. */
export class Files {
  readonly signer: FileSigner;
  readonly maxBytes: number;
  private readonly store: Store;
  private readonly root: string;

  constructor(store: Store, config: Config, bus: Bus, env: NodeJS.ProcessEnv = process.env) {
    this.store = store;
    this.root = join(config.NIBBLET_DATA_DIR, "files");
    this.signer = new FileSigner(config.NIBBLET_OWNER_TOKEN);
    this.maxBytes = Limits.parse(env).NIBBLET_MAX_FILE_MB * 1024 * 1024;
    // A deleted nibblet's rows go with it (cascade); its files on disk go here.
    bus.subscribe((m) => {
      if (m.type === "nibblet_deleted") {
        void rm(join(this.root, m.id), { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  path(nibbletId: string, fileId: string): string {
    return join(this.root, nibbletId, fileId);
  }

  async row(fileId: string): Promise<FileRow | null> {
    const [row] = await this.store.db.select().from(files).where(eq(files.id, fileId));
    return row ?? null;
  }

  /** The user's attachments for a message: theirs, ready, and on this nibblet. */
  async attachments(nibbletId: string, ids: string[]): Promise<FileRef[]> {
    if (ids.length === 0) return [];
    const rows = await this.store.db
      .select()
      .from(files)
      .where(and(eq(files.nibbletId, nibbletId), inArray(files.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row || row.status !== "ready")
        throw new RpcError("bad_request", `No file ${id} ready to send`);
      return toFileRef(row);
    });
  }

  signedUrl(fileId: string): string {
    const { exp, sig } = this.signer.sign("get", fileId, DOWNLOAD_TTL_MS);
    return `/api/files/${fileId}?exp=${exp}&sig=${sig}`;
  }

  /** Streams a request body to the file's place on disk; see `receiveTo`. */
  async receive(
    row: FileRow,
    body: ReadableStream<Uint8Array>,
    onProgress: (received: number) => void,
  ): Promise<{ size: number; sha256: string }> {
    await mkdir(join(this.root, row.nibbletId), { recursive: true });
    return receiveTo(this.path(row.nibbletId, row.id), body, this.maxBytes, onProgress);
  }

  async create(input: {
    nibbletId: string;
    name: string;
    mime: string;
    size: number;
    direction: "user" | "nibblet";
  }): Promise<FileRow> {
    if (input.size > this.maxBytes) {
      throw new RpcError(
        "bad_request",
        `Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB`,
      );
    }
    const [row] = await this.store.db
      .insert(files)
      .values({
        id: newId("file"),
        nibbletId: input.nibbletId,
        name: cleanName(input.name),
        mime: input.mime || "application/octet-stream",
        size: input.size,
        direction: input.direction,
        status: "uploading",
      })
      .returning();
    if (!row) throw new Error("insert returned nothing");
    return row;
  }

  async finish(fileId: string, patch: Partial<Pick<FileRow, "status" | "size" | "sha256">>) {
    const [row] = await this.store.db
      .update(files)
      .set(patch)
      .where(eq(files.id, fileId))
      .returning();
    return row ?? null;
  }

  /** A whole-file or ranged response, with the right type and disposition. */
  async respond(c: Context, row: FileRow): Promise<Response> {
    const path = this.path(row.nibbletId, row.id);
    const info = await stat(path).catch(() => null);
    if (!info || row.status !== "ready") return c.json({ error: "No such file" }, 404);
    const disposition = `${inlineMime(row.mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`;
    const headers: Record<string, string> = {
      "content-type": row.mime,
      "content-disposition": disposition,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    };
    const range = parseRange(c.req.header("range"), info.size);
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${info.size}` },
      });
    }
    const [start, end] = range ?? [0, info.size - 1];
    const stream = Readable.toWeb(createReadStream(path, { start, end }));
    headers["content-length"] = String(end - start + 1);
    if (range) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    return new Response(stream, { status: range ? 206 : 200, headers });
  }
}

/**
 * Streams a body to `target`, checking the size cap as it goes and calling
 * back with progress at most every `PROGRESS_EVERY_MS`. A body over the cap,
 * or one that breaks off, leaves no file behind.
 */
export async function receiveTo(
  target: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onProgress: (received: number) => void,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      if (received > maxBytes) {
        done(new Error(`Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      hash.update(chunk);
      const now = Date.now();
      if (now - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = now;
        onProgress(received);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body), meter, createWriteStream(target));
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  }
  return { size: received, sha256: hash.digest("hex") };
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n`; null for no header, "invalid" for one we can't serve. */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : "invalid";
}

const now = () => new Date().toISOString();

/**
 * The HTTP side. People upload with `POST /api/nibblets/:id/files?name=` and
 * download with `GET /api/files/:id` (bearer, or a signed link from
 * `POST /api/files/:id/link`). Runners fetch attachments and share files
 * through `/runner/files`, authenticated by their nibblet's token.
 */
export function mountFiles(app: Hono, filesService: Files, deps: FileDeps): void {
  const { store, routes, user } = deps;

  const nibbletFromRunner = async (c: Context) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token ? store.nibbletByToken(token) : null;
  };

  routes.post(
    "/api/nibblets/:id/files",
    {
      summary: "Uploads a file to attach to a message.",
      description:
        "The body is the file itself. Pass the `fileId` it answers with in `nibblets.send`'s `attachments`.",
      tags: ["files"],
      auth: user,
      params: { id: "The nibblet's id." },
      query: z.object({ name: z.string().default("file").describe("The file's name.") }),
      body: "binary",
      responses: {
        200: { description: "The stored file.", body: FileRef },
        404: { description: "No such nibblet.", body: HttpError },
        413: { description: "Too large, or the upload failed.", body: HttpError },
      },
    },
    async (c, { query }) => {
      const nibbletId = c.req.param("id") ?? "";
      const nibblet = await store.getNibblet(nibbletId).catch(() => null);
      if (!nibblet) return c.json({ error: "No such nibblet" }, 404);
      const body = c.req.raw.body;
      if (!body) return c.json({ error: "Send the file as the request body" }, 400);
      const declared = Number(c.req.header("content-length") ?? "0");
      let row: FileRow;
      try {
        row = await filesService.create({
          nibbletId,
          name: query.name,
          mime: (c.req.header("content-type") ?? "").split(";")[0] ?? "",
          size: Number.isFinite(declared) ? declared : 0,
          direction: "user",
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 413);
      }
      try {
        const { size, sha256 } = await filesService.receive(row, body, () => {});
        const done = await filesService.finish(row.id, { status: "ready", size, sha256 });
        return c.json(done ? toFileRef(done) : toFileRef(row));
      } catch (err) {
        await filesService.finish(row.id, { status: "failed" });
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 413);
      }
    },
  );

  routes.post(
    "/api/files/:id/link",
    {
      summary: "A link that downloads a file without signing in, for an hour.",
      tags: ["files"],
      auth: user,
      params: { id: "The file's id." },
      responses: {
        200: {
          description: "The link, relative to the server.",
          body: z.object({ url: z.string() }),
        },
        404: { description: "No such file.", body: HttpError },
      },
    },
    async (c) => {
      const id = c.req.param("id") ?? "";
      const row = await filesService.row(id);
      if (!row) return c.json({ error: "No such file" }, 404);
      return c.json({ url: filesService.signedUrl(id) });
    },
  );

  routes.get(
    "/api/files/:id",
    {
      summary: "Downloads a file, whole or a `Range` of it.",
      description:
        "Sign in, or pass the `exp` and `sig` of a link from `POST /api/files/{id}/link`.",
      tags: ["files"],
      // It checks for itself: a signed link will do instead.
      auth: { security: [{ bearer: [] }, {}] },
      params: { id: "The file's id." },
      query: z.object({ exp: z.string().optional(), sig: z.string().optional() }),
      responses: {
        200: { description: "The file.", body: "binary" },
        206: { description: "The range asked for.", body: "binary" },
        401: { description: "Neither signed in nor a working link.", body: HttpError },
        404: { description: "No such file.", body: HttpError },
        416: { description: "The range is outside the file." },
      },
    },
    async (c, { query: { exp, sig } }) => {
      const id = c.req.param("id") ?? "";
      const signed = exp && sig ? filesService.signer.verify("get", id, exp, sig) : false;
      if (!signed) {
        // Fall back to the usual sign-in for API clients that can send headers.
        let allowed = false;
        await user.check?.(c, async () => {
          allowed = true;
        });
        if (!allowed) return c.json({ error: "Sign in first" }, 401);
      }
      const row = await filesService.row(id);
      return row ? filesService.respond(c, row) : c.json({ error: "No such file" }, 404);
    },
  );

  // Runners: fetch the user's attachments for a turn.
  app.get("/runner/files/:id", async (c) => {
    const nibblet = await nibbletFromRunner(c);
    const row = nibblet ? await filesService.row(c.req.param("id") ?? "") : null;
    if (!nibblet || !row || row.nibbletId !== nibblet.id)
      return c.json({ error: "No such file" }, 404);
    return filesService.respond(c, row);
  });

  // Runners: ask to share a file. The UI shows it uploading straight away.
  app.post("/runner/files", async (c) => {
    const nibblet = await nibbletFromRunner(c);
    if (!nibblet) return c.json({ error: "unauthorized" }, 401);
    const input = ShareRequest.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: z.prettifyError(input.error) }, 400);
    let row: FileRow;
    try {
      row = await filesService.create({
        nibbletId: nibblet.id,
        name: input.data.name,
        mime: input.data.mime,
        size: input.data.size,
        direction: "nibblet",
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 413);
    }
    const item: Extract<ThreadItem, { type: "file" }> = {
      type: "file",
      id: row.id,
      turnId: input.data.turnId,
      createdAt: now(),
      ...toFileRef(row),
      caption: input.data.caption,
      status: "uploading",
      received: 0,
      error: null,
    };
    await store.putItem(nibblet.id, item);
    const { exp, sig } = filesService.signer.sign("put", row.id, UPLOAD_TTL_MS);
    return c.json({ fileId: row.id, url: `/runner/files/${row.id}/upload?exp=${exp}&sig=${sig}` });
  });

  // Runners: the upload itself, to the signed link from `POST /runner/files`.
  app.put("/runner/files/:id/upload", async (c) => {
    const id = c.req.param("id") ?? "";
    const exp = c.req.query("exp") ?? "";
    const sig = c.req.query("sig") ?? "";
    if (!filesService.signer.verify("put", id, exp, sig))
      return c.json({ error: "Link expired" }, 403);
    const row = await filesService.row(id);
    const body = c.req.raw.body;
    if (!row || row.status !== "uploading" || !body)
      return c.json({ error: "No upload waiting" }, 404);
    const item = await store.getItem(row.nibbletId, row.id);
    const update = async (patch: Partial<Extract<ThreadItem, { type: "file" }>>) => {
      if (item?.type === "file") await store.putItem(row.nibbletId, { ...item, ...patch });
    };
    try {
      const { size, sha256 } = await filesService.receive(row, body, (received) => {
        void update({ received });
      });
      await filesService.finish(id, { status: "ready", size, sha256 });
      await update({ status: "ready", size, received: size });
      return c.json({ ok: true, fileId: id, size });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await filesService.finish(id, { status: "failed" });
      await update({ status: "failed", error: message });
      return c.json({ error: message }, 413);
    }
  });
}

const ShareRequest = z.object({
  name: z.string().min(1),
  mime: z.string().default("application/octet-stream"),
  size: z.int().nonnegative(),
  caption: z.string().max(500).nullable().default(null),
  turnId: z.string().nullable().default(null),
});
