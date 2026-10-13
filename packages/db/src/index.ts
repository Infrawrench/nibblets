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

/** Creates the vector extension, then applies any pending migrations. */
export async function migrateDb(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
}
