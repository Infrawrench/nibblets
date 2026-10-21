import type { CardFile } from "@nibblets/protocol";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardFiles } from "./cards.ts";

const file: CardFile = {
  id: "card_abc-1",
  provider: "fake",
  asset: "USD",
  kind: "multi_use",
  limit: "25.00",
  purpose: "Domain renewal",
  details: {
    type: "card",
    pan: "4242424242424242",
    cvv: "123",
    expMonth: "01",
    expYear: "2031",
    billingAddress: null,
  },
};

describe("CardFiles", () => {
  let root: string;
  let cards: CardFiles;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cards-test-"));
    cards = new CardFiles(join(root, "nibblet-cards"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("writes the card where only its user can read it", async () => {
    const path = await cards.put(file);
    expect(path).toBe(join(root, "nibblet-cards", "card_abc-1.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(file);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "nibblet-cards"))).mode & 0o777).toBe(0o700);
  });

  it("replaces a card's file, and removes it (twice is fine)", async () => {
    await cards.put(file);
    const path = await cards.put({ ...file, limit: "30.00" });
    expect(JSON.parse(await readFile(path, "utf8")).limit).toBe("30.00");
    await cards.remove(file.id);
    await cards.remove(file.id);
    await expect(stat(path)).rejects.toThrow();
  });

  it("removes a card asked to go while it's still being written", async () => {
    // The server can time out on a put and kill the card before the put lands.
    const writing = cards.put(file);
    await cards.remove(file.id);
    await writing;
    await expect(stat(cards.pathOf(file.id))).rejects.toThrow();
    await expect(stat(`${cards.pathOf(file.id)}.partial`)).rejects.toThrow();
  });

  it("refuses an id that could leave its folder", async () => {
    await expect(cards.put({ ...file, id: "../escape" })).rejects.toThrow(/isn't a card id/);
    await expect(cards.remove("a/b")).rejects.toThrow(/isn't a card id/);
  });
});
