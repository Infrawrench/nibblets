import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import type { HostContext, ImageJob } from "@nibblet/machine/host";
import { provisionMacos } from "./provision.ts";
import { z } from "zod";

const run = promisify(execFile);

/** How big a macOS guest's disk is; it's sparse, so this is only what it may grow to. */
const MACOS_DISK_GB = 80;

const Restore = z.object({ url: z.url(), build: z.string(), version: z.int() });
const Progress = z.union([z.object({ progress: z.number() }), z.object({ done: z.literal(true) })]);

/** Downloads `url` to `file`, saying how far it's got. A part file starts again. */
async function download(
  url: string,
  file: string,
  progress: (fraction: number | null) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Downloading macOS failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const out = createWriteStream(`${file}.part`);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      progress(total > 0 ? got / total : null);
      if (!out.write(value)) await once(out, "drain");
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  await rename(`${file}.part`, file);
}

/**
 * A macOS guest's image: the newest macOS this Mac supports, downloaded
 * from Apple (a restore image, the size of macOS) and installed into a
 * disk with the helper, then given the guest agent (provision.ts). The
 * restore image is kept beside the images, so making one again (for a new
 * release of Nibblets) doesn't download it again.
 */
export async function prepareMacos(ctx: HostContext, helper: string, job: ImageJob): Promise<void> {
  job.progress(null, "Asking Apple for the newest macOS");
  const restore = Restore.parse(JSON.parse((await run(helper, ["macos-restore-url"])).stdout));
  const cache = join(ctx.dir, "restore");
  await mkdir(cache, { recursive: true });
  const ipsw = join(cache, `macOS-${restore.build}.ipsw`);
  const have = await stat(ipsw).then(
    () => true,
    () => false,
  );
  if (!have) {
    // Older ones are of no use any more.
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    await download(restore.url, ipsw, (f) =>
      job.progress(
        f === null ? null : f * 0.5,
        `Downloading macOS ${restore.version} (${restore.build})`,
      ),
    );
  }
  job.progress(0.5, `Installing macOS ${restore.version}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, ["macos-install", job.dir, ipsw, String(MACOS_DISK_GB)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const said = Progress.safeParse(JSON.parse(line || "null"));
        if (said.success && "progress" in said.data) {
          job.progress(0.5 + said.data.progress * 0.4, `Installing macOS ${restore.version}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk.toString("utf8")).slice(-2000)));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `Installing exited ${code}`)),
    );
  });
  await provisionMacos(ctx, helper, job);
}
