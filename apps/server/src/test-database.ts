import type { Db } from "@nibblet/db";

const DATABASE_TEST_LOCK = 4_200_518;

export async function lockTestDatabase(db: Db): Promise<() => Promise<void>> {
  const connection = await db.$client.reserve();
  try {
    await connection`SELECT pg_advisory_lock(${DATABASE_TEST_LOCK})`;
  } catch (error) {
    connection.release();
    throw error;
  }
  return async () => {
    try {
      await connection`SELECT pg_advisory_unlock(${DATABASE_TEST_LOCK})`;
    } finally {
      connection.release();
    }
  };
}
