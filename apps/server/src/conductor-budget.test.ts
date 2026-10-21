import type { CredentialStatus, Nibblet, ThreadItem } from "@nibblet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.ts";
import { Conductor } from "./conductor.ts";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";

const proxyStatus = (source: CredentialStatus["source"]): CredentialStatus[] => [
  {
    provider: "anthropic",
    source,
    ok: true,
    detail: "",
    plan: null,
    expiresAt: null,
    limitedUntil: null,
  },
];

/** Just enough of Store for budget waits. */
function fakeStore(nibblets: Partial<Nibblet>[]) {
  const settings = new Map<string, unknown>();
  const items = new Map<string, ThreadItem>();
  const spent = new Map<string, number>();
  const store = {
    spent,
    nibblets,
    async getSetting<T>(key: string, parse: (v: unknown) => T, fallback: T) {
      return settings.has(key) ? parse(settings.get(key)) : fallback;
    },
    async setSetting(key: string, value: unknown) {
      settings.set(key, JSON.parse(JSON.stringify(value)));
    },
    async getItem(_id: string, itemId: string) {
      return items.get(itemId) ?? null;
    },
    async putItem(nibbletId: string, item: ThreadItem) {
      items.set(item.id, item);
      return { nibbletId, seq: items.size, item };
    },
    async setStatus() {},
    async getNibblet(id: string) {
      const n = nibblets.find((x) => x.id === id);
      if (!n) throw new Error(`No nibblet ${id}`);
      return n as Nibblet;
    },
    async spentUsd(id: string) {
      return spent.get(id) ?? 0;
    },
  };
  return store;
}

const config = {
  CREDPROXY_URL: "http://credproxy",
  CREDPROXY_ADMIN_KEY: "admin",
  NIBBLET_APPROVAL_TIMEOUT_MINUTES: 30,
  HOST_MCP_URL: "",
} as unknown as Config;

describe("budget waits", () => {
  let proxy: () => Response;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    proxy = () => Response.json(proxyStatus("env"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => proxy()),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function waiting(nibblets: Partial<Nibblet>[], spentUsd: number) {
    const store = fakeStore(nibblets);
    store.spent.set("nib_top", spentUsd);
    const conductor = new Conductor(store as unknown as Store, {} as Orchestrator, config);
    for (const n of nibblets) {
      await conductor.limits.start(
        n.id ?? "",
        null,
        new Date("2026-11-01T00:00:00Z"),
        [],
        "budget",
      );
    }
    return { store, conductor };
  }

  const top = {
    id: "nib_top",
    parentId: null,
    harness: "claude",
    model: "claude-opus-5-5",
    monthlyBudgetUsd: 5,
  } as const;
  const child = {
    id: "nib_child",
    parentId: "nib_top",
    harness: "claude",
    model: "claude-opus-5-5",
    monthlyBudgetUsd: null,
  } as const;

  it("keep waiting while the budget is still spent", async () => {
    const { conductor } = await waiting([top, child], 5);
    await conductor.recheckBudgetWaits("nib_top");
    expect(conductor.limits.waitingFor("budget").sort()).toEqual(["nib_child", "nib_top"]);
  });

  it("end for the whole tree once the budget is raised", async () => {
    const { conductor, store } = await waiting([top, child], 5);
    store.nibblets[0] = { ...top, monthlyBudgetUsd: 10 };
    await conductor.recheckBudgetWaits("nib_child");
    expect(conductor.limits.waitingFor("budget")).toEqual([]);
  });

  it("end for a nibblet moved off the API key, but not its tree-mates", async () => {
    const { conductor, store } = await waiting([top, child], 5);
    store.nibblets[1] = { ...child, harness: "kimi", model: "kimi-code/k3" };
    await conductor.recheckBudgetWaits("nib_child");
    expect(conductor.limits.waitingFor("budget")).toEqual(["nib_top"]);
  });

  it("end when the proxy is back on a subscription, but not while it can't be asked", async () => {
    const { conductor } = await waiting([top], 5);
    proxy = () => {
      throw new Error("connection refused");
    };
    await conductor.recheckBudgetWaits();
    expect(conductor.limits.waitingFor("budget")).toEqual(["nib_top"]);
    proxy = () => Response.json(proxyStatus("file"));
    await vi.advanceTimersByTimeAsync(20_000);
    await conductor.recheckBudgetWaits();
    expect(conductor.limits.waitingFor("budget")).toEqual([]);
  });

  it("skip a waiting nibblet that's gone, and carry on with the rest", async () => {
    const { conductor, store } = await waiting([top, { ...top, id: "nib_gone" }], 5);
    store.nibblets.splice(1, 1);
    store.nibblets[0] = { ...top, monthlyBudgetUsd: 10 };
    await conductor.recheckBudgetWaits();
    expect(conductor.limits.waitingFor("budget")).toEqual(["nib_gone"]);
  });
});
