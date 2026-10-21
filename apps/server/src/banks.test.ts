import { BankError, defineBankFactory, defineBankPlugin, defineField } from "@nibblet/bank";
import {
  MASKED,
  type BankProviderId,
  type CardSecret,
  type PublicAddress,
} from "@nibblet/protocol";
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
  purchaseHook: { where: "In Fake's settings." },
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
  /** Which banks each purchase request was offered to. */
  const asked: string[][] = [];
  const reached: { address: PublicAddress } = {
    address: { url: null, via: null, proxy: null },
  };
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
          approvesPurchases: false,
        })),
        problems: [],
      }),
      use: (next) => {
        plugins = new Map([...next].map(([id, p]) => [id, { label: p.label }]));
        loaded.push([...next.keys()]);
      },
      purchase: async (ids) => {
        asked.push([...ids]);
        return null;
      },
    },
    address: { current: async () => reached.address },
    env,
    factories: [fake],
    plugin: { fetch: globalThis.fetch, log: () => {} },
    log: (m) => logs.push(m),
  });
  return { banks, settings, live, loaded, logs, asked, reached };
}

/** A change to the fake bank: a new one, unless `id` says which. */
const change = (settings: Record<string, string>, more: { id?: string; name?: string } = {}) => ({
  id: more.id ?? null,
  kind: "fake",
  name: more.name ?? "",
  settings,
});

describe("setting banks up", () => {
  it("saves settings the provider takes, and loads the bank with them", async () => {
    const { banks, settings, loaded } = setUp();
    await banks.load();
    expect(loaded).toEqual([[]]);
    const status = await banks.configure(change({ FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" }));
    expect(settings.get("banks")).toEqual([
      { id: "fake", kind: "fake", name: "", settings: { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" } },
    ]);
    expect(loaded.at(-1)).toEqual(["fake"]);
    expect(status.providers.map((p) => p.label)).toEqual(["Fake (acc)"]);
    expect(status.kinds.map((k) => k.id)).toEqual(["fake"]);
    expect(status.banks).toEqual([
      {
        id: "fake",
        kind: "fake",
        name: "",
        source: "saved",
        settings: { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" },
        liveCards: 0,
      },
    ]);
  });

  it("keeps a secret sent back masked", async () => {
    const { banks, settings } = setUp();
    await banks.configure(change({ FAKE_KEY: "k1" }));
    await banks.configure(change({ FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" }, { id: "fake" }));
    expect(settings.get("banks")).toEqual([
      { id: "fake", kind: "fake", name: "", settings: { FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" } },
    ]);
  });

  it("sets up several banks on one plugin, each with a name and its own id", async () => {
    const { banks, loaded } = setUp();
    await banks.configure(change({ FAKE_KEY: "k1" }));
    await expect(banks.configure(change({ FAKE_KEY: "k2" }))).rejects.toThrow(
      "Give it a name, to tell it from your other Fake bank",
    );
    await banks.configure(change({ FAKE_KEY: "k2" }, { name: "Travel" }));
    await expect(banks.configure(change({ FAKE_KEY: "k3" }, { name: "travel" }))).rejects.toThrow(
      "There's already a Fake bank called travel",
    );
    const status = await banks.configure(change({ FAKE_KEY: "k3" }, { name: "Ops" }));
    expect(status.banks.map((b) => [b.id, b.name])).toEqual([
      ["fake", ""],
      ["fake-travel", "Travel"],
      ["fake-ops", "Ops"],
    ]);
    expect(loaded.at(-1)).toEqual(["fake", "fake-travel", "fake-ops"]);
    // Renaming keeps its id, which its cards point at.
    const renamed = await banks.configure(
      change({ FAKE_KEY: MASKED }, { id: "fake-travel", name: "Holidays" }),
    );
    expect(renamed.banks.map((b) => [b.id, b.name])).toContainEqual(["fake-travel", "Holidays"]);
  });

  it("saves nothing the provider refuses, saying why", async () => {
    const { banks, settings, logs } = setUp();
    await expect(banks.configure(change({ FAKE_KEY: "" }))).rejects.toThrow("API key is needed");
    await expect(banks.configure(change({ FAKE_KEY: "short" }))).rejects.toThrow(
      "API key is too short",
    );
    await expect(banks.configure(change({ FAKE_KEY: "wrong" }))).rejects.toThrow(
      "Fake: Invalid API key",
    );
    // Anything but a BankError could carry a credential, so it's only logged.
    const down = banks.configure(change({ FAKE_KEY: "down" }));
    await expect(down).rejects.toThrow("Fake didn't answer; the server's log has why");
    expect(logs.join("\n")).toContain("key=down");
    await expect(banks.configure({ ...change({}), kind: "nope" })).rejects.toThrow(
      "No bank plugin called nope",
    );
    await expect(banks.configure(change({ FAKE_KEY: "k" }, { id: "nope" }))).rejects.toThrow(
      "No bank called nope",
    );
    expect(settings.has("banks")).toBe(false);
  });

  it("won't change what open cards depend on, or remove a bank they need", async () => {
    const { banks, live, settings } = setUp();
    await banks.configure(change({ FAKE_KEY: "k1", FAKE_ACCOUNT: "acc" }));
    await banks.configure(change({ FAKE_KEY: "k2" }, { name: "Travel" }));
    live.push({ provider: "fake-travel" }, { provider: "other" });
    await expect(
      banks.configure(
        change({ FAKE_KEY: MASKED, FAKE_ACCOUNT: "x" }, { id: "fake-travel", name: "Travel" }),
      ),
    ).rejects.toThrow("Account can't change while Travel (Fake) has a card that isn't closed");
    // Its other fields still can, and the bank without cards can change anything.
    await banks.configure(change({ FAKE_KEY: "k3" }, { id: "fake-travel", name: "Travel" }));
    await banks.configure(change({ FAKE_KEY: MASKED, FAKE_ACCOUNT: "y" }, { id: "fake" }));
    await expect(banks.remove("fake-travel")).rejects.toThrow(
      "Travel (Fake) has a card that isn't closed, and closing them needs it",
    );
    await banks.remove("fake");
    live.length = 0;
    await banks.remove("fake-travel");
    expect(settings.get("banks")).toEqual([]);
  });

  it("falls back to the environment, and lets Settings take over from it", async () => {
    const { banks, loaded } = setUp({ FAKE_KEY: "from-env" });
    await banks.load();
    expect(loaded).toEqual([["fake"]]);
    expect((await banks.status()).banks[0]).toMatchObject({
      id: "fake",
      source: "env",
      settings: { FAKE_KEY: MASKED },
    });
    await expect(banks.remove("fake")).rejects.toThrow(/server's environment/);
    // A second bank needs a name, and leaves the environment's in place.
    await banks.configure(change({ FAKE_KEY: "k2" }, { name: "Travel" }));
    expect((await banks.status()).banks.map((b) => [b.id, b.source])).toEqual([
      ["fake-travel", "saved"],
      ["fake", "env"],
    ]);
    // Saving the environment's keeps its key when it's sent back masked, and takes it over.
    await banks.configure(change({ FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" }, { id: "fake" }));
    expect((await banks.status()).banks.find((b) => b.id === "fake")).toMatchObject({
      source: "saved",
      settings: { FAKE_KEY: MASKED, FAKE_ACCOUNT: "acc" },
    });
    await banks.remove("fake");
    expect((await banks.status()).banks.find((b) => b.id === "fake")).toMatchObject({
      source: "env",
    });
  });
});

describe("providers that ask about purchases", () => {
  it("are given the address this server is reached at, once it has one", async () => {
    const { banks, reached } = setUp();
    const hook = async () => (await banks.status()).kinds[0]?.purchaseHook;
    expect(await hook()).toEqual({ url: null, changes: false, where: "In Fake's settings." });
    reached.address = { url: "https://pip.nibblets.dev", via: "tunnel", proxy: null };
    expect(await hook()).toEqual({
      url: "https://pip.nibblets.dev/bank/fake/purchases",
      changes: false,
      where: "In Fake's settings.",
    });
    reached.address = { url: "https://a-b.trycloudflare.com", via: "quick_tunnel", proxy: null };
    expect(await hook()).toMatchObject({ changes: true });
  });

  it("have a request offered to the banks on its plugin", async () => {
    const { banks, asked } = setUp();
    await banks.configure(change({ FAKE_KEY: "k1" }));
    await banks.configure(change({ FAKE_KEY: "k2" }, { name: "Travel" }));
    const request = { headers: new Headers(), body: "{}" };
    expect(await banks.purchase("fake", request)).toBeNull();
    await banks.purchase("slash", request);
    expect(asked).toEqual([["fake", "fake-travel"], []]);
  });
});
