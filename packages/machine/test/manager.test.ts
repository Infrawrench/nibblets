import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HostMachines, type HypervisorPlugin, type ImageJob } from "../src/host/index.ts";

/** A hypervisor that only makes Windows images, and keeps what it was asked. */
function fake(jobs: ImageJob[]): HypervisorPlugin {
  const none = () => Promise.reject(new Error("not in this test"));
  return {
    id: "fake",
    name: "Fake",
    diskFormat: "raw",
    detect: async () => ({ available: true, detail: null, guests: ["windows"] }),
    imageSource: () => "windows-iso",
    prepareImage: async (_ctx, _guest, job) => void jobs.push(job),
    start: none,
    stop: none,
    running: async () => false,
    remove: none,
    connect: none,
    console: async () => "",
    capacity: async () => null,
  };
}

const Images = z.object({
  hypervisors: z.array(
    z.object({
      guests: z.array(
        z.object({ image: z.object({ state: z.string(), builtFrom: z.string().nullable() }) }),
      ),
    }),
  ),
});

describe("making an image on the host", () => {
  let server: Server | null = null;
  let dir = "";
  afterEach(async () => {
    server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Asks for a Windows image with `body`, and says what the plugin was told and what it's made from. */
  async function prepare(
    body: object,
  ): Promise<{ job: ImageJob | undefined; builtFrom: string | null }> {
    dir = await mkdtemp(join(tmpdir(), "nibblet-manager-"));
    const jobs: ImageJob[] = [];
    const machines = new HostMachines({
      plugins: [fake(jobs)],
      dir,
      docker: null,
      targets: { server: "http://127.0.0.1:1", credproxy: "http://127.0.0.1:1" },
    });
    const listening = createServer((req, res) => {
      void machines.handle(req, res, new URL(req.url ?? "/", "http://bridge").pathname);
    });
    server = listening;
    await new Promise<void>((r) => listening.listen(0, "127.0.0.1", () => r()));
    const address = listening.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const res = await fetch(`${base}/machines/fake/images/windows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/isos/windows.iso", ...body }),
    });
    expect(res.status).toBe(202);
    for (;;) {
      const found = Images.parse(await (await fetch(`${base}/machines`)).json());
      const image = found.hypervisors[0]?.guests[0]?.image;
      if (image?.state === "ready") return { job: jobs[0], builtFrom: image.builtFrom };
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("installs the runner from the server's release", async () => {
    const { job, builtFrom } = await prepare({ version: "1.2.3", repo: "someone/nibblets" });
    expect(job?.ref).toBe("v1.2.3");
    expect(job?.repo).toBe("someone/nibblets");
    expect(builtFrom).toBe("v1.2.3");
  });

  it("installs it from another ref when it's told one, such as a commit under test", async () => {
    const { job, builtFrom } = await prepare({ version: "1.2.3", ref: "4da5099c" });
    expect(job?.ref).toBe("4da5099c");
    expect(job?.repo).toBe("Infrawrench/nibblets");
    expect(builtFrom).toBe("4da5099c");
  });
});
