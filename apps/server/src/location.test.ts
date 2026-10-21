import { connect, EMBEDDING_DIMENSIONS, migrateDb, type Db } from "@nibblet/db";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Bus } from "./bus.ts";
import { Geocoder } from "./geocode.ts";
import { createHandlers, type Services } from "./handlers.ts";
import { Store } from "./store.ts";

/** Needs Postgres with pgvector: see snapshots.test.ts. */
const url = process.env.NIBBLET_TEST_DATABASE_URL;

describe.skipIf(!url)("sharing a location with a nibblet", () => {
  let db: Db;
  let store: Store;
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
    store = new Store(db, new Bus(), {
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
});
