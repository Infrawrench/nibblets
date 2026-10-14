import { serve } from "@hono/node-server";
import { connect, migrateDb } from "@nibblet/db";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { Conductor } from "./conductor.ts";
import { loadConfig } from "./config.ts";
import { Orchestrator } from "./docker.ts";
import { createEmbedder } from "./embeddings.ts";
import { serverName } from "./handlers.ts";
import { HarnessModelLists } from "./opencode.ts";
import { Scheduler } from "./scheduler.ts";
import { Snapshots } from "./snapshots.ts";
import { Store } from "./store.ts";
import { Files } from "./files.ts";
import { Tunnel } from "./tunnel.ts";
import { Connect } from "./connect.ts";
import { tailscaleStatus } from "./hostmcp.ts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  await migrateDb(db);

  const bus = new Bus();
  const store = new Store(
    db,
    bus,
    createEmbedder(config.NIBBLET_EMBEDDINGS, config.NIBBLET_DATA_DIR),
  );
  const serverId = await store.getSetting("serverId", (v) => z.string().parse(v), "");
  const id = serverId || randomUUID();
  if (!serverId) await store.setSetting("serverId", id);

  const docker = new Orchestrator(config);
  if (!(await docker.ping())) throw new Error("Can't reach Docker. Is the socket mounted?");
  await docker.ensureNetwork();

  const conductor = new Conductor(store, docker, config);
  conductor.serverName = await serverName(store);
  const scheduler = new Scheduler(store, conductor);
  const snapshots = new Snapshots({
    store,
    bus,
    docker,
    conductor,
    scheduler,
    dataDir: config.NIBBLET_DATA_DIR,
  });
  const tunnel = new Tunnel(docker, store, config);
  const central = new Connect({
    store,
    tunnel,
    config,
    version: VERSION,
    serverName: () => serverName(store),
    nibbletCount: async () => (await store.listNibblets()).length,
    tailscaleUrl: async () => (await tailscaleStatus(config)).url,
  });

  const app = createApp(
    {
      config,
      store,
      conductor,
      scheduler,
      tunnel,
      connect: central,
      models: new HarnessModelLists(config, docker),
      serverId: id,
      version: VERSION,
      files: new Files(store, config, bus),
      snapshots,
    },
    bus,
  );
  const wss = new WebSocketServer({ noServer: true });
  serve(
    {
      fetch: app.fetch,
      port: config.PORT,
      hostname: "0.0.0.0",
      websocket: { server: wss },
      // Its replacement Response breaks transformers.js downloading the embedding model.
      overrideGlobalObjects: false,
    },
    (info) => console.log(`nibblet server ${VERSION} on :${info.port}`),
  );

  await conductor.reconcile();
  await scheduler.start();
  snapshots.start();
  // The tunnel follows the Connect link: on with it, off without.
  await central.restore();

  const shutdown = () => {
    scheduler.stop();
    snapshots.stop();
    central.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
