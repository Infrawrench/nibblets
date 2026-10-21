import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connect, EMBEDDING_DIMENSIONS, migrateDb, type Db } from "@nibblets/db";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocationFix } from "@nibblets/protocol";
import { Bus } from "./bus.ts";
import { Geocoder } from "./geocode.ts";
import { LocationRequests } from "./location-requests.ts";
import { createHandlers, type Services } from "./handlers.ts";
import { buildServer } from "./mcp.ts";
import { Store } from "./store.ts";

/** Needs Postgres with pgvector: see snapshots.test.ts. */
const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe.skipIf(!url)("sharing a location with a nibblet", () => {
  let db: Db;
  let store: Store;
  let bus: Bus;
  let pip: string;
  const lookups = vi.fn<typeof fetch>(async () =>
    Response.json({
      address: {
        suburb: "Shoreditch",
        city: "London",
        state: "England",
        postcode: "E2 7DG",
        country: "United Kingdom",
        country_code: "gb",
      },
    }),
  );
  const reconfigure = vi.fn(async () => undefined);
  const update = (input: Parameters<ReturnType<typeof createHandlers>["nibblets"]["update"]>[0]) =>
    createHandlers({
      store,
      geocoder: new Geocoder({ url: "https://n.example", version: "1", fetch: lookups }),
      models: { accepts: async () => true },
      conductor: { recheckBudgetWaits: async () => undefined, reconfigure },
    } as unknown as Services).nibblets.update(input, {});

  beforeAll(async () => {
    // A database of its own, so the other database tests can't empty its tables.
    const admin = connect(url ?? "");
    const exists = await admin.execute(
      sql`SELECT 1 FROM pg_database WHERE datname = 'nibblet_location_test'`,
    );
    if (exists.length === 0) await admin.execute(sql`CREATE DATABASE nibblet_location_test`);
    await admin.$client.end();
    const own = new URL(url ?? "");
    own.pathname = "/nibblet_location_test";
    db = connect(own.toString());
    await migrateDb(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE nibblets CASCADE`);
    lookups.mockClear();
    bus = new Bus();
    store = new Store(db, bus, {
      name: "test",
      embed: async (texts) =>
        texts.map(() => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)),
    });
    pip = (
      await store.createNibblet(
        { name: "Pip", harness: "claude", model: "claude-opus-5-5", effort: "medium" },
        null,
      )
    ).nibblet.id;
  });

  it("has none until one's shared", async () => {
    expect((await store.getNibblet(pip)).location).toBeNull();
  });

  it("looks up the place a position is in, and keeps both", async () => {
    const fix = {
      latitude: 51.524612,
      longitude: -0.078134,
      accuracyM: 35,
      timeZone: "Europe/London",
    };
    const updated = await update({ id: pip, location: fix });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(updated.location).toMatchObject({
      ...fix,
      place: { neighbourhood: "Shoreditch", city: "London", countryCode: "GB" },
    });
    expect((await store.getNibblet(pip)).location).toEqual(updated.location);
    expect(reconfigure).toHaveBeenCalledWith(pip);
  });

  it("leaves it alone when something else changes, and forgets it when asked", async () => {
    await update({
      id: pip,
      location: { latitude: 1, longitude: 2, accuracyM: null, timeZone: null },
    });
    await update({ id: pip, plain: true });
    expect((await store.getNibblet(pip)).location?.latitude).toBe(1);
    expect(lookups).toHaveBeenCalledTimes(1);
    await update({ id: pip, location: null });
    expect((await store.getNibblet(pip)).location).toBeNull();
  });

  const here = {
    latitude: 51.5246,
    longitude: -0.0781,
    accuracyM: 35,
    timeZone: "Europe/London",
  } satisfies LocationFix;

  /**
   * Calls `location_get` as the nibblet `id` would, over MCP, with a device
   * that answers as given: where it is, no, or nothing at all. With no
   * device, no Nibblets is open.
   */
  const ask = async (id: string, device?: LocationFix | null | "silent") => {
    const locations = new LocationRequests({
      store,
      geocoder: new Geocoder({ url: "https://n.example", version: "1", fetch: lookups }),
      viewers: () => (device === undefined ? 0 : 1),
      timeoutMs: 200,
    });
    // The device, the way an open UI hears of it: over the live feed.
    const off = bus.subscribe((m) => {
      if (m.type !== "item" || m.item.item.type !== "location_request") return;
      if (m.item.item.status !== "pending" || device === undefined || device === "silent") return;
      void locations.answer(m.item.nibbletId, m.item.item.id, device);
    });
    const server = buildServer(await store.getNibblet(id), {
      store,
      locations,
      conductor: { activeTurnId: () => "turn_1" },
      bank: { enabled: false },
    } as unknown as Parameters<typeof buildServer>[1]);
    const [client, served] = InMemoryTransport.createLinkedPair();
    await server.connect(served);
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(client);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    const result = await mcp.callTool({ name: "location_get", arguments: {} });
    await mcp.close();
    off();
    const [first] = result.content as { type: string; text: string }[];
    return { tools, text: first?.text ?? "" };
  };
  const requests = async (id: string) =>
    (await store.recentItems(id, 20)).filter((i) => i.type === "location_request");

  it("asks the device where they are now, and keeps it", async () => {
    const { tools, text } = await ask(pip, here);
    expect(tools).toContain("location_get");
    const answer = JSON.parse(text);
    expect(answer).toMatchObject({
      place: "Shoreditch, London, England, United Kingdom",
      timeZone: "Europe/London",
      latitude: 51.5246,
      fresh: true,
    });
    expect(answer.localTime).toMatch(/(GMT|BST)$/);
    expect((await store.getNibblet(pip)).location).toMatchObject(here);
    expect(await requests(pip)).toMatchObject([{ status: "shared", turnId: "turn_1" }]);
  });

  it("falls back to where they last shared when no Nibblets is open, or none answers", async () => {
    expect((await ask(pip)).text).toContain("never shared where they are");
    await update({ id: pip, location: here });
    const closed = JSON.parse((await ask(pip)).text);
    expect(closed).toMatchObject({ fresh: false, latitude: 51.5246 });
    expect(closed.note).toContain("No Nibblets was open");
    const silent = JSON.parse((await ask(pip, "silent")).text);
    expect(silent.note).toContain("didn't answer in time");
    expect(await requests(pip)).toMatchObject([{ status: "unanswered" }]);
  });

  it("says no when they decline, without the last place", async () => {
    await update({ id: pip, location: here });
    const { text } = await ask(pip, null);
    expect(text).toContain("chose not to share");
    expect(text).not.toContain("London");
  });

  it("asks for a sub-agent too, and keeps the answer at the top of the tree", async () => {
    const scout = (
      await store.createNibblet(
        { name: "Scout", harness: "claude", model: "claude-opus-5-5", effort: "medium" },
        pip,
      )
    ).nibblet.id;
    expect(JSON.parse((await ask(scout, here)).text).city).toBe("London");
    expect((await store.getNibblet(pip)).location).toMatchObject(here);
    expect((await store.getNibblet(scout)).location).toBeNull();
    expect(await store.locationOf(scout)).toEqual(await store.locationOf(pip));
  });
});
