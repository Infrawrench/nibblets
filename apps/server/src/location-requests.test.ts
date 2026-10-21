import type { NibbletLocation, ThreadItemOf } from "@nibblet/protocol";
import { describe, expect, it, vi } from "vitest";
import { LocationRequests, type LocationStore } from "./location-requests.ts";

type Item = ThreadItemOf<"location_request">;

const london = {
  neighbourhood: "Shoreditch",
  city: "London",
  region: "England",
  postcode: "E2 7DG",
  country: "United Kingdom",
  countryCode: "GB",
};
const fix = { latitude: 51.5246, longitude: -0.0781, accuracyM: 35, timeZone: "Europe/London" };

function setup(opts: { viewers?: number; timeoutMs?: number } = {}) {
  const rows = new Map<string, { parentId: string | null; location: NibbletLocation | null }>([
    ["nib_top", { parentId: null, location: null }],
    ["nib_child", { parentId: "nib_top", location: null }],
  ]);
  const items = new Map<string, Item>();
  const store: LocationStore = {
    putItem: async (_id, item) => void items.set(item.id, item),
    updateNibblet: async (id, patch) => {
      const row = rows.get(id);
      if (row) row.location = patch.location;
    },
    nibbletRow: async (id) => {
      const row = rows.get(id);
      if (!row) throw new Error(`No nibblet ${id}`);
      return row;
    },
    pendingLocationRequests: async () =>
      [...items.values()]
        .filter((i) => i.status === "pending")
        .map((item) => ({ nibbletId: "nib_top", item })),
  };
  const place = vi.fn(async () => london);
  const requests = new LocationRequests({
    store,
    geocoder: { place },
    viewers: () => opts.viewers ?? 1,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  /** The one request waiting, once it's in the thread. */
  const waiting = async () => {
    await vi.waitFor(() =>
      expect([...items.values()].some((i) => i.status === "pending")).toBe(true),
    );
    const item = [...items.values()].find((i) => i.status === "pending");
    if (!item) throw new Error("nothing waiting");
    return item;
  };
  return { rows, items, place, requests, waiting };
}

describe("LocationRequests", () => {
  it("doesn't ask when no Nibblets is open to answer", async () => {
    const { requests, items } = setup({ viewers: 0 });
    expect(await requests.ask("nib_top", "turn_1")).toEqual({ kind: "nobody" });
    expect(items.size).toBe(0);
  });

  it("asks in the thread, and keeps what the device says", async () => {
    const { requests, items, rows, waiting } = setup();
    const asked = requests.ask("nib_top", "turn_1");
    const item = await waiting();
    expect(item).toMatchObject({ turnId: "turn_1", status: "pending", place: null });
    await requests.answer("nib_top", item.id, fix);
    const answer = await asked;
    expect(answer).toMatchObject({ kind: "shared", location: { ...fix, place: london } });
    expect(rows.get("nib_top")?.location).toMatchObject({ ...fix, place: london });
    expect(items.get(item.id)).toMatchObject({
      status: "shared",
      place: "Shoreditch, London, England, United Kingdom",
    });
  });

  it("takes the first device's answer, and turns the next away", async () => {
    const { requests, waiting } = setup();
    const asked = requests.ask("nib_top", null);
    const item = await waiting();
    await requests.answer("nib_top", item.id, fix);
    await expect(requests.answer("nib_top", item.id, fix)).rejects.toThrow(/any more/);
    await expect(asked).resolves.toMatchObject({ kind: "shared" });
  });

  it("only takes an answer for the nibblet that asked", async () => {
    const { requests, waiting } = setup();
    void requests.ask("nib_top", null);
    const item = await waiting();
    await expect(requests.answer("nib_child", item.id, fix)).rejects.toThrow(/any more/);
  });

  it("hears a no, and keeps nothing", async () => {
    const { requests, items, rows, place, waiting } = setup();
    const asked = requests.ask("nib_top", null);
    const item = await waiting();
    await requests.answer("nib_top", item.id, null);
    expect(await asked).toEqual({ kind: "declined" });
    expect(items.get(item.id)?.status).toBe("declined");
    expect(rows.get("nib_top")?.location).toBeNull();
    expect(place).not.toHaveBeenCalled();
  });

  it("stops waiting when nobody answers in time", async () => {
    const { requests, items, waiting } = setup({ timeoutMs: 20 });
    const asked = requests.ask("nib_top", null);
    const item = await waiting();
    expect(await asked).toEqual({ kind: "unanswered" });
    expect(items.get(item.id)?.status).toBe("unanswered");
  });

  it("asks once for two asks at the same time", async () => {
    const { requests, items, waiting } = setup();
    const first = requests.ask("nib_top", null);
    const item = await waiting();
    const second = requests.ask("nib_top", null);
    await requests.answer("nib_top", item.id, fix);
    expect(await second).toEqual(await first);
    expect(items.size).toBe(1);
  });

  it("keeps a sub-agent's answer at the top of its tree, unless it has its own", async () => {
    const { requests, rows, waiting } = setup();
    const asked = requests.ask("nib_child", null);
    await requests.answer("nib_child", (await waiting()).id, fix);
    await asked;
    expect(rows.get("nib_top")?.location).not.toBeNull();
    expect(rows.get("nib_child")?.location).toBeNull();

    const own = { ...fix, place: null, sharedAt: "2026-10-21T00:00:00.000Z" };
    const child = rows.get("nib_child");
    if (child) child.location = own;
    const again = requests.ask("nib_child", null);
    await requests.answer("nib_child", (await waiting()).id, { ...fix, latitude: 48.86 });
    await again;
    expect(rows.get("nib_child")?.location?.latitude).toBe(48.86);
  });

  it("gives up when its turn stops, and after a restart", async () => {
    const { requests, items, waiting } = setup();
    const asked = requests.ask("nib_top", null);
    const item = await waiting();
    await requests.cancelAll("nib_top");
    expect(await asked).toEqual({ kind: "unanswered" });
    expect(items.get(item.id)?.status).toBe("unanswered");

    // One left pending by a server that's gone.
    items.set("loc_old", { ...item, id: "loc_old", status: "pending" });
    await requests.resetStale();
    expect(items.get("loc_old")?.status).toBe("unanswered");
  });
});
