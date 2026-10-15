import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretFiles } from "../src/secret-files.ts";

describe("secret files", () => {
  it("writes a file only its user can read, and removes it", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "secrets-")), "files");
    const secrets = new SecretFiles(dir);
    const path = await secrets.put("card_1.json", '{"cvc":"123"}');
    expect(path).toBe(join(dir, "card_1.json"));
    expect(await readFile(join(dir, "card_1.json"), "utf8")).toBe('{"cvc":"123"}');
    expect((await stat(join(dir, "card_1.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await secrets.put("card_1.json", null)).toBeNull();
    await expect(stat(join(dir, "card_1.json"))).rejects.toThrow();
  });

  it("never writes outside its folder", async () => {
    const secrets = new SecretFiles(await mkdtemp(join(tmpdir(), "secrets-")));
    await expect(secrets.put("../escape.json", "x")).rejects.toThrow(/Bad file name/);
    await expect(secrets.put(".hidden", "x")).rejects.toThrow(/Bad file name/);
  });
});
