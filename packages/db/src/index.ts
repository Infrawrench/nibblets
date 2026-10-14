import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

export type Db = ReturnType<typeof connect>;

export function connect(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle(client, { schema });
}

/** Any number, so long as it's always the same: the lock migrations take turns on. */
const MIGRATION_LOCK = 4_200_517;

/**
 * Creates the vector extension, then applies any pending migrations. On one
 * connection holding an advisory lock, so two at once (tests, or servers
 * starting together) take turns rather than racing to create the same things.
 */
export async function migrateDb(db: Db): Promise<void> {
  // The lock lives on one reserved connection for as long as this runs; the
  // migrations themselves use the pool, and anyone else waits on the lock.
  const conn = await db.$client.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  } finally {
    await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => undefined);
    conn.release();
  }
}
