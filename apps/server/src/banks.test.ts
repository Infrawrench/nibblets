import { BankError, defineBankFactory, defineBankPlugin, defineField } from "@nibblet/bank";
import { MASKED, type BankProviderId, type CardSecret } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { Banks } from "./banks.ts";

const secret: CardSecret = {
  type: "card",
  pan: "4111111111111111",
  cvv: "123",
  expMonth: "01",
  expYear: "2030",
  billingAddress: null,
};

const KEY = defineField("FAKE_KEY", "API key", { required: true, secret: true });
const ACCOUNT = defineField("FAKE_ACCOUNT", "Account", { lockedByCards: true });

/** A bank that turns on with a key, refuses the key `wrong`, and can't be reached with `down`. */
const fake = defineBankFactory({
  id: "fake",
  name: "Fake",
  about: "Cards for tests.",
  instrument: "card",
  fields: [KEY, ACCOUNT],
  fromSettings(settings) {
    const key = settings.FAKE_KEY;
    if (!key) return null;
    if (key === "short") throw new Error("API key is too short");
    return defineBankPlugin({
      id: "fake",
      label: `Fake (${settings.FAKE_ACCOUNT ?? "default"})`,
      asset: { code: "USD", decimals: 2 },
      instrument: "card",
      fundAt: null,
      check: async () => {
        if (key === "wrong") throw new BankError("Fake: Invalid API key");
        if (key === "down") throw new Error("connect to https://fake.example?key=down failed");
      },
      balance: async () => 500n,
      issue: async () => ({ ref: "r", display: "•••• 1111", secret }),
      find: async () => null,
      reveal: async () => secret,
      inspect: async () => ({ open: true, spent: 0n, used: false }),
      close: async () => ({ open: false, spent: 0n, used: false, settled: true }),
    });
  },
});

function setUp(env: Record<string, string> = {}) {
  const settings = new Map<string, unknown>();
  const live: { provider: string }[] = [];
  const loaded: string[][] = [];
  const logs: string[] = [];
  let plugins = new Map<BankProviderId, { label: string }>();
  const banks = new Banks({
    store: {
      async getSetting<T>(key: string, parse: (v: unknown) => T, fallback: T) {
        return settings.has(key) ? parse(settings.get(key)) : fallback;
      },
      async setSetting(key: string, value: unknown) {
        settings.set(key, structuredClone(value));
      },
      liveCards: async () => live,
    },
    bank: {
      status: async () => ({
        providers: [...plugins.entries()].map(([id, p]) => ({
          id,
          label: p.label,
          asset: { code: "USD", decimals: 2 },
          instrument: "card" as const,
          state: "ready" as const,
          detail: null,
          balance: "500",
          fundAt: null,
        })),
        problems: [],
      }),
      use: (next) => {
        plugins = new Map([...next].map(([id, p]) => [id, { label: p.label }]));
        loaded.push([...next.keys()]);
      },
    },
    env,
    factories: [fake],
    plugin: { fetch: globalThis.fetch, log: () => {} },
    log: (m) => logs.push(m),
  });
  return { banks, settings, live, loaded, logs };
}

describe("setting banks up", () => {
  it("saves settings the provider takes, and loads the bank with them", async () => {
    const { banks, settings, loaded } = setUp();
    await banks.load();
    expect(loaded).toEqual([[]]);
    const status = await banks.configure("fake", { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" });
    expect(settings.get("banks")).toEqual({ fake: { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" } });
    expect(loaded.at(-1)).toEqual(["fake"]);
    expect(status.providers.map((p) => p.label)).toEqual(["Fake (acc)"]);
    expect(status.kinds).toEqual([
      expect.objectContaining({
        id: "fake",
        name: "Fake",
        source: "saved",
        settings: { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" },
        liveCards: 0,
      }),
    ]);
  });

  it("keeps a secret sent back masked", async () => {
    const { banks, settings } = setUp();
    await banks.configure("fake", { FAKE_KEY: "k1" });
    await banks.configure("fake", { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" });
    expect(settings.get("banks")).toEqual({ fake: { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" } });
  });

  it("saves nothing the provider refuses, saying why", async () => {
    const { banks, settings, logs } = setUp();
    await expect(banks.configure("fake", { FAKE_KEY: "" })).rejects.toThrow("API key is needed");
    await expect(banks.configure("fake", { FAKE_KEY: "short" })).rejects.toThrow(
      "API key is too short",
    );
    await expect(banks.configure("fake", { FAKE_KEY: "wrong" })).rejects.toThrow(
      "Fake: Invalid API key",
    );
    // Anything but a BankError could carry a credential, so it's only logged.
    const down = banks.configure("fake", { FAKE_KEY: "down" });
    await expect(down).rejects.toThrow("Fake didn't answer; the server's log has why");
    expect(logs.join("\n")).toContain("key=down");
    await expect(banks.configure("nope", {})).rejects.toThrow("No bank called nope");
    expect(settings.has("banks")).toBe(false);
  });

  it("won't change what open cards depend on, or remove a bank they need", async () => {
    const { banks, live, settings } = setUp();
    await banks.configure("fake", { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" });
    live.push({ provider: "fake" }, { provider: "other" });
    await expect(
      banks.configure("fake", { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc2" }),
    ).rejects.toThrow(
      "Account can't change while Fake has a card that isn't closed: kill them first.",
    );
    // Fields that aren't locked still can.
    await banks.configure("fake", { FAKE_KEY: "k2", FAKE_ACCOUNT: "acc" });
    await expect(banks.remove("fake")).rejects.toThrow(
      "Fake has a card that isn't closed, and closing them needs it",
    );
    live.length = 0;
    await banks.remove("fake");
    expect(settings.get("banks")).toEqual({});
  });

  it("falls back to the environment, and lets Settings take over from it", async () => {
    const { banks, loaded } = setUp({ FAKE_KEY: "from-env" });
    await banks.load();
    expect(loaded).toEqual([["fake"]]);
    expect((await banks.status()).kinds[0]).toMatchObject({
      source: "env",
      settings: { FAKE_KEY: MASKED },
    });
    // Saving keeps the environment's key when it's sent back masked.
    await banks.configure("fake", { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" });
    expect((await banks.status()).kinds[0]).toMatchObject({ source: "saved" });
    await banks.remove("fake");
    expect((await banks.status()).kinds[0]).toMatchObject({ source: "env" });
  });
});
