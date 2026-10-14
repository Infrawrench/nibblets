import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanName, FileSigner, inlineMime, parseRange, receiveTo } from "./files.ts";

const dir = mkdtempSync(join(tmpdir(), "nibblet-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });

describe("FileSigner", () => {
  const signer = new FileSigner("owner-token-for-tests");
  const t0 = Date.parse("2026-10-14T12:00:00Z");

  it("accepts its own link until it expires", () => {
    const { exp, sig } = signer.sign("get", "file_a", 60_000, t0);
    expect(signer.verify("get", "file_a", String(exp), sig, t0 + 30_000)).toBe(true);
    expect(signer.verify("get", "file_a", String(exp), sig, t0 + 61_000)).toBe(false);
  });

  it("won't let a link for one file or purpose open another", () => {
    const { exp, sig } = signer.sign("get", "file_a", 60_000, t0);
    expect(signer.verify("get", "file_b", String(exp), sig, t0)).toBe(false);
    expect(signer.verify("put", "file_a", String(exp), sig, t0)).toBe(false);
    expect(signer.verify("get", "file_a", String(exp + 3600), sig, t0)).toBe(false);
  });

  it("rejects links signed with another key", () => {
    const other = new FileSigner("someone-elses-token");
    const { exp, sig } = other.sign("get", "file_a", 60_000, t0);
    expect(signer.verify("get", "file_a", String(exp), sig, t0)).toBe(false);
  });
});

describe("receiveTo", () => {
  it("writes the file and reports its size and hash", async () => {
    const target = join(dir, "ok");
    const result = await receiveTo(target, body("hello ", "hamster"), 1024, () => {});
    expect(result.size).toBe(13);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(target, "utf8")).toBe("hello hamster");
  });

  it("refuses files over the cap and leaves nothing behind", async () => {
    const target = join(dir, "big");
    await expect(
      receiveTo(target, body("x".repeat(600), "y".repeat(600)), 1000, () => {}),
    ).rejects.toThrow(/up to/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("helpers", () => {
  it("parses ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual([0, 9]);
    expect(parseRange("bytes=90-", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=200-300", 100)).toBe("invalid");
  });

  it("keeps names safe", () => {
    expect(cleanName("../../etc/passwd")).toBe("passwd");
    expect(cleanName("C:\\Users\\a\\report.pdf")).toBe("report.pdf");
    expect(cleanName("..")).toBe("file");
  });

  it("shows only safe types inline", () => {
    expect(inlineMime("image/png")).toBe(true);
    expect(inlineMime("application/pdf")).toBe(true);
    expect(inlineMime("image/svg+xml")).toBe(false);
    expect(inlineMime("text/html")).toBe(false);
  });

  it("has a files migration", () => {
    const sql = readFileSync(
      new URL("../../../packages/db/migrations/0005_files.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE "files"');
    const journal = readFileSync(
      new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    );
    expect(journal).toContain('"tag": "0005_files"');
  });
});
