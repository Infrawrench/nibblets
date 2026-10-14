import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guessMime, RunnerFiles, uniqueName } from "../src/files.ts";

const work = mkdtempSync(join(tmpdir(), "runner-files-"));
const TOKEN = "nibblet-token";
const received: { slot?: unknown; upload?: string; auth?: string } = {};
let server: Server;
let base = "";

// A stand-in for the nibblet server's /runner/files routes.
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url?.startsWith("/runner/files/")) {
        received.auth = req.headers.authorization;
        res.end(`contents of ${req.url.split("/").pop()}`);
      } else if (req.method === "POST" && req.url === "/runner/files") {
        received.slot = JSON.parse(text);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ fileId: "file_1", url: "/runner/files/file_1/upload?exp=1&sig=x" }),
        );
      } else if (req.method === "PUT" && req.url?.startsWith("/runner/files/file_1/upload")) {
        received.upload = text;
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

const files = () =>
  new RunnerFiles({ serverUrl: base, token: TOKEN, workdir: work, currentTurn: () => "turn_9" });

describe("RunnerFiles", () => {
  it("downloads attachments into uploads/, keeping clashing names apart", async () => {
    const got = await files().fetch([
      { fileId: "file_a", name: "notes.txt", mime: "text/plain", size: 5 },
      { fileId: "file_b", name: "notes.txt", mime: "text/plain", size: 5 },
    ]);
    expect(got.map((g) => g.name)).toEqual(["notes.txt", "notes (2).txt"]);
    expect(got[0]?.path).toBe(join(work, "uploads", "notes.txt"));
    expect(readFileSync(join(work, "uploads", "notes (2).txt"), "utf8")).toBe("contents of file_b");
    expect(received.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("shares a file: asks for a slot with its details, then uploads it", async () => {
    writeFileSync(join(work, "report.csv"), "a,b\n1,2\n");
    const message = await files().share("report.csv", undefined, "The numbers");
    expect(message).toBe("Shared report.csv with the user.");
    expect(received.slot).toEqual({
      name: "report.csv",
      mime: "text/csv",
      size: 8,
      caption: "The numbers",
      turnId: "turn_9",
    });
    expect(received.upload).toBe("a,b\n1,2\n");
  });

  it("says plainly when there's no such file", async () => {
    await expect(files().share("missing.txt")).rejects.toThrow("No file at missing.txt");
  });

  it("names and types files", () => {
    expect(uniqueName("a.png", new Set(["a.png", "a (2).png"]))).toBe("a (3).png");
    expect(guessMime("photo.JPG")).toBe("image/jpeg");
    expect(guessMime("thing.xyz")).toBe("application/octet-stream");
  });
});
