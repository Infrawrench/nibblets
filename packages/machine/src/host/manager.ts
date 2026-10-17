import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { GUEST_NAMES, GuestOs } from "@nibblet/protocol";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  PrepareImage,
  StartVm,
  StopVm,
  UpdateVm,
  type HostImage,
  type HypervisorInfo,
  type VmInfo,
} from "../bridge-api.ts";
import { wsSocket } from "../bridge-client.ts";
import { buildLinuxImage } from "./linux-image.ts";
import type { HostContext, HypervisorPlugin, VmRef } from "./hypervisor.ts";
import { GuestRelay, type RelayTargets } from "./relay.ts";

export interface HostMachinesOptions {
  plugins: readonly HypervisorPlugin[];
  /** Where images and VMs live, a folder for each hypervisor. */
  dir: string;
  /** The Docker CLI, which makes Linux images. */
  docker: string | null;
  /** Where the guests' connections go: the server and the credential proxy, as the host reaches them. */
  targets: RelayTargets;
  log?: (message: string) => void;
}

/** A VM's record, in its folder as `vm.json`. */
const VmRecord = z.object({
  guest: GuestOs,
  cpus: z.int(),
  memoryMb: z.int(),
  boot: z.string().nullable(),
  /** What its system disk was made from, and the image folder it came from. */
  image: z.string().nullable(),
  imageDir: z.string(),
  tailscale: z.boolean(),
});
type VmRecord = z.infer<typeof VmRecord>;

/** An image's current version, as `current.json` in its guest's folder. */
const CurrentImage = z.object({ dir: z.string(), builtFrom: z.string() });
type CurrentImage = z.infer<typeof CurrentImage>;

const Id = z.string().regex(/^[\w-]+$/);

/** What can be said of a request that's wrong. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Job {
  progress: number | null;
  detail: string | null;
  error: string | null;
  running: boolean;
}

type Detected = Awaited<ReturnType<HypervisorPlugin["detect"]>>;

/** One hypervisor, with what the bridge keeps for it. */
class Hypervisor {
  readonly plugin: HypervisorPlugin;
  readonly ctx: HostContext;
  readonly jobs = new Map<GuestOs, Job>();
  readonly relays = new Map<string, GuestRelay>();
  private readonly targets: RelayTargets;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(plugin: HypervisorPlugin, ctx: HostContext, targets: RelayTargets) {
    this.plugin = plugin;
    this.ctx = ctx;
    this.targets = targets;
  }

  private detection: { at: number; found: Promise<Detected> } | null = null;

  /**
   * What it says it can do here, asked at most every half minute: some
   * plugins ask a slow tool (Hyper-V's are PowerShell), and the server asks often.
   */
  detected(): Promise<Detected> {
    if (!this.detection || Date.now() - this.detection.at > 30_000) {
      this.detection = {
        at: Date.now(),
        found: this.plugin.detect(this.ctx).catch((err: unknown) => ({
          available: false,
          detail: err instanceof Error ? err.message : String(err),
          guests: [],
        })),
      };
    }
    return this.detection.found;
  }

  exclusive<T>(id: string, job: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(job);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  vmDir(id: string): string {
    return join(this.ctx.dir, "vms", id);
  }

  ref(id: string): VmRef {
    return { id, dir: this.vmDir(id) };
  }

  imagesDir(guest: GuestOs): string {
    return join(this.ctx.dir, "images", guest);
  }

  async current(guest: GuestOs): Promise<CurrentImage | null> {
    const text = await readFile(join(this.imagesDir(guest), "current.json"), "utf8").catch(
      () => null,
    );
    return text ? CurrentImage.parse(JSON.parse(text)) : null;
  }

  async record(id: string): Promise<VmRecord | null> {
    const text = await readFile(join(this.vmDir(id), "vm.json"), "utf8").catch(() => null);
    return text ? VmRecord.parse(JSON.parse(text)) : null;
  }

  async save(id: string, record: VmRecord): Promise<void> {
    await mkdir(this.vmDir(id), { recursive: true });
    const file = join(this.vmDir(id), "vm.json");
    await writeFile(`${file}.new`, JSON.stringify(record, null, 2));
    await rename(`${file}.new`, file);
  }

  async ids(): Promise<string[]> {
    const entries = await readdir(join(this.ctx.dir, "vms"), { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter((e) => e.isDirectory() && Id.safeParse(e.name).success)
      .map((e) => e.name);
  }

  async info(id: string, record: VmRecord): Promise<VmInfo> {
    const running = await this.plugin.running(this.ctx, this.ref(id)).catch(() => false);
    if (running) this.relay(id);
    return {
      id,
      guest: record.guest,
      running,
      boot: record.boot,
      image: record.image,
      tailscale: record.tailscale,
    };
  }

  /** Its agent's port, relayed, for as long as it runs; made (and connected) on first need. */
  relay(id: string): GuestRelay {
    const existing = this.relays.get(id);
    if (existing) return existing;
    const relay = new GuestRelay(this.targets, (m) => this.ctx.log(`[${id}] ${m}`));
    this.relays.set(id, relay);
    void this.keepConnected(id, relay);
    return relay;
  }

  /** Connects the relay to its port, and again whenever it drops, until the VM stops. */
  private async keepConnected(id: string, relay: GuestRelay): Promise<void> {
    const ref = this.ref(id);
    let quiet = 0;
    for (;;) {
      if (this.relays.get(id) !== relay) return;
      const running = await this.plugin.running(this.ctx, ref).catch(() => false);
      if (!running) {
        // Give one that's just starting a moment before letting go of it.
        if (++quiet > 20) {
          relay.close();
          if (this.relays.get(id) === relay) this.relays.delete(id);
          return;
        }
      } else if (!relay.connected) {
        quiet = 0;
        try {
          const port: Duplex = await this.plugin.connect(this.ctx, ref);
          relay.attachPort(port);
        } catch {
          // Not up yet: the hypervisor makes the port as it boots.
        }
      } else quiet = 0;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * The host bridge's `/machines` API (see bridge-api.ts), for whichever
 * hypervisor plugins it loads. It keeps each VM's record (its guest, size
 * and boot) in its folder, makes images, and relays each running VM's
 * agent port to the server.
 */
export class HostMachines {
  private readonly hypervisors = new Map<string, Hypervisor>();
  private readonly docker: string | null;
  private readonly log: (message: string) => void;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  constructor(opts: HostMachinesOptions) {
    this.docker = opts.docker;
    this.log = opts.log ?? (() => {});
    for (const plugin of opts.plugins) {
      const ctx: HostContext = {
        dir: join(opts.dir, plugin.id),
        docker: opts.docker,
        log: (m) => this.log(`${plugin.id}: ${m}`),
      };
      this.hypervisors.set(plugin.id, new Hypervisor(plugin, ctx, opts.targets));
    }
  }

  private get(id: string | undefined): Hypervisor {
    const hv = id ? this.hypervisors.get(id) : undefined;
    if (!hv) throw new HttpError(404, `No hypervisor ${id ?? ""} here`);
    return hv;
  }

  async describe(): Promise<HypervisorInfo[]> {
    return Promise.all(
      [...this.hypervisors.values()].map(async (hv) => {
        const found = await hv.detected();
        return {
          id: hv.plugin.id,
          name: hv.plugin.name,
          available: found.available,
          detail: found.detail,
          guests: await Promise.all(
            found.guests.map(async (os) => ({ os, image: await this.image(hv, os) })),
          ),
        };
      }),
    );
  }

  private async image(hv: Hypervisor, guest: GuestOs): Promise<HostImage> {
    const source = hv.plugin.imageSource(guest);
    const job = hv.jobs.get(guest);
    const current = await hv.current(guest);
    if (job?.running) {
      return {
        state: "preparing",
        detail: job.detail,
        progress: job.progress,
        source,
        builtFrom: current?.builtFrom ?? null,
      };
    }
    if (current) {
      return { state: "ready", detail: null, progress: null, source, builtFrom: current.builtFrom };
    }
    if (job?.error) {
      return { state: "error", detail: job.error, progress: null, source, builtFrom: null };
    }
    const linux = guest === "linux" && !this.docker;
    return {
      state: "missing",
      detail: linux ? "The Docker CLI isn't here to make it with" : null,
      progress: null,
      source,
      builtFrom: null,
    };
  }

  /** Starts making a guest's image, unless it's already being made. */
  private prepare(hv: Hypervisor, guest: GuestOs, body: PrepareImage): void {
    if (hv.jobs.get(guest)?.running) return;
    const job: Job = { progress: null, detail: "Starting", error: null, running: true };
    hv.jobs.set(guest, job);
    const progress = (fraction: number | null, detail: string | null) => {
      job.progress = fraction;
      if (detail) job.detail = detail;
    };
    void (async () => {
      const dir = join(hv.imagesDir(guest), new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(dir, { recursive: true });
      try {
        let builtFrom: string;
        if (guest === "linux") {
          if (!this.docker) throw new Error("The Docker CLI isn't here to make it with");
          if (!body.runnerImage) throw new Error("Which runner image to make it from?");
          builtFrom = await buildLinuxImage({
            docker: this.docker,
            runnerImage: body.runnerImage,
            format: hv.plugin.diskFormat,
            dir,
            progress,
          });
        } else {
          await hv.plugin.prepareImage(hv.ctx, guest, {
            dir,
            source: body.source,
            version: body.version ?? "",
            repo: body.repo ?? "Infrawrench/nibblets",
            progress,
          });
          builtFrom = body.version ?? "";
        }
        const file = join(hv.imagesDir(guest), "current.json");
        await writeFile(`${file}.new`, JSON.stringify({ dir, builtFrom }));
        await rename(`${file}.new`, file);
        hv.ctx.log(`made its ${GUEST_NAMES[guest]} image in ${dir}`);
        await this.prune(hv, guest);
      } catch (err) {
        job.error = err instanceof Error ? err.message : String(err);
        hv.ctx.log(`couldn't make its ${GUEST_NAMES[guest]} image: ${job.error}`);
        await rm(dir, { recursive: true, force: true });
      } finally {
        job.running = false;
      }
    })();
  }

  /** Old versions of an image that no VM was made from any more. */
  private async prune(hv: Hypervisor, guest: GuestOs): Promise<void> {
    const current = await hv.current(guest);
    const used = new Set<string>(current ? [current.dir] : []);
    for (const id of await hv.ids()) {
      const record = await hv.record(id).catch(() => null);
      if (record) used.add(record.imageDir);
    }
    const dir = hv.imagesDir(guest);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !used.has(path)) await rm(path, { recursive: true, force: true });
    }
  }

  private async start(hv: Hypervisor, id: string, body: StartVm): Promise<VmInfo> {
    return hv.exclusive(id, async () => {
      const before = await hv.record(id);
      const ref = hv.ref(id);
      if (before && (await hv.plugin.running(hv.ctx, ref))) return hv.info(id, before);
      const image = await hv.current(body.guest);
      const fresh = body.fresh || !before || before.guest !== body.guest;
      if (fresh && !image) {
        throw new HttpError(409, `There's no ${GUEST_NAMES[body.guest]} image to make it from`);
      }
      const record: VmRecord = {
        guest: body.guest,
        cpus: body.cpus,
        memoryMb: body.memoryMb,
        boot: randomUUID(),
        image: fresh ? (image?.builtFrom ?? null) : (before?.image ?? null),
        imageDir: fresh ? (image?.dir ?? "") : (before?.imageDir ?? ""),
        tailscale: (before?.tailscale ?? false) || body.tailscale,
      };
      await hv.save(id, record);
      await hv.plugin.start(hv.ctx, {
        ...ref,
        guest: record.guest,
        cpus: record.cpus,
        memoryMb: record.memoryMb,
        imageDir: record.imageDir,
        fresh,
      });
      return hv.info(id, record);
    });
  }

  /** `/machines` and below. Throws HttpError for a request that's wrong. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    try {
      await this.route(req, res, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof z.ZodError ? 400 : 500;
      if (status === 500) this.log(`machines: ${err instanceof Error ? err.stack : String(err)}`);
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    if (parts.length === 1 && method === "GET") {
      return json(res, 200, { hypervisors: await this.describe() });
    }
    const hv = this.get(parts[1]);
    const [, , what, name, action] = parts;
    if (what === "capacity" && method === "GET") {
      return json(res, 200, await hv.plugin.capacity(hv.ctx));
    }
    if (what === "images" && method === "POST") {
      const guest = GuestOs.parse(name);
      const body = PrepareImage.parse(await readJson(req));
      this.prepare(hv, guest, body);
      return json(res, 202, { ok: true });
    }
    if (what !== "vms") throw new HttpError(404, "Not found");
    if (!name) {
      if (method !== "GET") throw new HttpError(405, "GET only");
      const out: VmInfo[] = [];
      for (const id of await hv.ids()) {
        const record = await hv.record(id).catch(() => null);
        if (record) out.push(await hv.info(id, record));
      }
      return json(res, 200, out);
    }
    const id = Id.parse(name);
    if (!action && method === "PUT") {
      return json(res, 200, await this.start(hv, id, StartVm.parse(await readJson(req))));
    }
    const record = await hv.record(id);
    if (!record) throw new HttpError(404, `No VM for ${id}`);
    if (!action && method === "PATCH") {
      const patch = UpdateVm.parse(await readJson(req));
      return json(
        res,
        200,
        await hv.exclusive(id, async () => {
          const next = { ...((await hv.record(id)) ?? record), ...patch };
          await hv.save(id, next);
          return hv.info(id, next);
        }),
      );
    }
    if (!action && method === "DELETE") {
      await hv.exclusive(id, async () => {
        hv.relays.get(id)?.close();
        hv.relays.delete(id);
        await hv.plugin.stop(hv.ctx, hv.ref(id), true).catch(() => undefined);
        await hv.plugin.remove(hv.ctx, hv.ref(id));
        await rm(hv.vmDir(id), { recursive: true, force: true });
      });
      for (const guest of GuestOs.options) await this.prune(hv, guest);
      return json(res, 200, { ok: true });
    }
    if (action === "stop" && method === "POST") {
      const { force } = StopVm.parse(await readJson(req));
      await hv.plugin.stop(hv.ctx, hv.ref(id), force);
      return json(res, 200, await hv.info(id, record));
    }
    if (action === "console" && method === "GET") {
      return json(res, 200, { text: await hv.plugin.console(hv.ctx, hv.ref(id)) });
    }
    throw new HttpError(404, "Not found");
  }

  /**
   * `GET /machines/:hv/vms/:id/link` as a WebSocket: the server's end of a
   * VM's agent port. False if it isn't one of ours.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): boolean {
    const m = /^\/machines\/([^/]+)\/vms\/([\w-]+)\/link$/.exec(path);
    const hv = m?.[1] ? this.hypervisors.get(decodeURIComponent(m[1])) : undefined;
    const id = m?.[2];
    if (!hv || !id) return false;
    void (async () => {
      const record = await hv.record(id);
      const running = record && (await hv.plugin.running(hv.ctx, hv.ref(id)).catch(() => false));
      if (!running) {
        socket.end("HTTP/1.1 409 Conflict\r\nconnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => hv.relay(id).attachServer(wsSocket(ws)));
    })().catch(() => socket.destroy());
    return true;
  }

  close(): void {
    for (const hv of this.hypervisors.values()) {
      for (const relay of hv.relays.values()) relay.close();
      hv.relays.clear();
    }
    this.wss.close();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Send JSON");
  }
}
