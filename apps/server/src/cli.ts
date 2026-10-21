import { connect, migrateDb } from "@nibblet/db";
import { readFileSync } from "node:fs";
import { Bus } from "./bus.ts";
import { loadConfig } from "./config.ts";
import type { Services } from "./handlers.ts";
import { Store } from "./store.ts";

/**
 * `node src/cli.ts pair [--url <base>]` prints a one-time sign-in link.
 * The desktop app runs this inside the server container on first launch.
 *
 * `node src/cli.ts openapi` prints what a server serves at /api/openapi.json,
 * without a database or config. Releases attach it.
 */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "openapi") return openapi();
  if (command !== "pair") {
    console.error("usage: cli.ts pair [--url <base url>] | cli.ts openapi");
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

async function openapi(): Promise<void> {
  // Imported here so `pair` doesn't load the whole server.
  const { createApp } = await import("./app.ts");
  const { version } = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  // Serving the description touches none of the services.
  const services = {
    config: { NIBBLET_OWNER_TOKEN: "", NIBBLET_WEB_DIST: "/nonexistent" },
    conductor: {},
    version,
  } as unknown as Services;
  const res = await createApp(services, new Bus()).request("/api/openapi.json");
  if (!res.ok) throw new Error(`/api/openapi.json answered ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
