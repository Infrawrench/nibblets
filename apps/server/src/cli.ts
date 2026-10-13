import { connect, migrateDb } from "@nibblet/db";
import { Bus } from "./bus.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";

/**
 * `node src/cli.ts pair [--url <base>]` prints a one-time sign-in link.
 * The desktop app runs this inside the server container on first launch.
 */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "pair") {
    console.error("usage: cli.ts pair [--url <base url>]");
    process.exit(2);
  }
  const config = loadConfig();
  const urlFlag = args.indexOf("--url");
  const base = urlFlag >= 0 ? args[urlFlag + 1] : config.NIBBLET_PUBLIC_URL;
  const db = connect(config.DATABASE_URL);
  await migrateDb(db);
  const store = new Store(db, new Bus(), {
    name: "unused",
    embed: () => Promise.reject(new Error("no embeddings in the CLI")),
  });
  const { code } = await store.createPairingCode(15 * 60_000);
  console.log(`${base}/#pair=${code}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
