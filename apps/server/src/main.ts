// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { connect, migrateDb } from "@nibblets/db";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import { Conductor } from "./conductor.ts";
import { Borrow } from "./borrow.ts";
import { loadConfig } from "./config.ts";
import { Orchestrator } from "./docker.ts";
import { HypervisorClient, MachineRegistry, VirtualMachines } from "@nibblets/machine";
import { meta as apple } from "@nibblets/machine-apple/meta";
import { meta as hyperv } from "@nibblets/machine-hyperv/meta";
import { meta as kvm } from "@nibblets/machine-kvm/meta";
import { createEmbedder } from "./embeddings.ts";
import { serverName } from "./handlers.ts";
import { HarnessModelLists } from "./opencode.ts";
import { Scheduler } from "./scheduler.ts";
import { Snapshots } from "./snapshots.ts";
import { Store } from "./store.ts";
import { Files } from "./files.ts";
import { Tunnel } from "./tunnel.ts";
import { Connect } from "./connect.ts";
import { AppUpdater, HarnessUpdater } from "./updates.ts";
import { Notifier } from "./notifier.ts";
import { tailscaleStatus } from "./hostmcp.ts";
import { Bank } from "./bank.ts";
import { Banks } from "./banks.ts";
import { AppLinks } from "./app-links.ts";
import { Geocoder } from "./geocode.ts";
import { LocationRequests } from "./location-requests.ts";
import { PublicAddresses } from "./public-address.ts";

// The repository's version, which releases are tagged with.
const VERSION = z
  .object({ version: z.string() })
  .parse(
    JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")),
  ).version;

/** The host's hypervisor plugins, which run in the host bridge; the server only needs their names. */
const hypervisors = [apple, hyperv, kvm];

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
  // A borrow doesn't outlive the server that started it.
  await docker
    .removeBorrowProxies()
    .catch((err: unknown) => console.warn("couldn't remove old borrow proxies", err));

  // Where nibblets run: containers on this engine, and virtual machines on
  // whatever hypervisors the host bridge offers.
  const bridge = { url: config.HOST_MCP_URL, token: config.HOST_MCP_TOKEN };
  const runnerImage = async () => {
    const name = config.NIBBLET_RUNNER_IMAGE;
    const found = await docker.docker
      .getImage(name)
      .inspect()
      .catch(() => null);
    return found ? { name, id: found.Id } : null;
  };
  const machines = new MachineRegistry([
    docker.machines(),
    ...hypervisors.map(
      (meta) =>
        new VirtualMachines({
          meta,
          client: new HypervisorClient(bridge, meta.id),
          runnerImage,
          version: VERSION,
          repo: config.NIBBLET_UPDATE_REPO,
          ...(config.NIBBLET_GUEST_REF ? { ref: config.NIBBLET_GUEST_REF } : {}),
        }),
    ),
  ]);
  const conductor = new Conductor(store, machines, config);
  conductor.serverName = await serverName(store, config.NIBBLET_HOST_NAME);
  conductor.terminals.onTasks = (nibbletId, tasks) =>
    bus.publish({ type: "tasks", nibbletId, tasks });
  conductor.terminals.onApps = (nibbletId, apps) => bus.publish({ type: "apps", nibbletId, apps });
  const bank = new Bank({
    store,
    plugins: new Map(),
    files: conductor.cardFiles,
    publish: (message) => bus.publish(message),
    log: (message) => console.warn(`bank: ${message}`),
  });
  const tunnel = new Tunnel(docker, store, config);
  const publicAddress = new PublicAddresses({ store, tunnel });
  const banks = new Banks({ store, bank, address: publicAddress, env: process.env });
  await banks.load();
  conductor.bank = bank;
  const appLinks = new AppLinks({
    store,
    publish: (message) => bus.publish(message),
    label: async () => `Nibblets on ${await serverName(store, config.NIBBLET_HOST_NAME)}`,
    // Sub-agents serve their host's app links, so they're handed them again too.
    reconfigure: async (nibbletId) => {
      const tree = [nibbletId];
      for (let i = 0; i < tree.length; i++) {
        const id = tree[i] ?? "";
        await conductor.reconfigure(id);
        tree.push(...(await store.children(id)).map((child) => child.id));
      }
    },
  });
  conductor.appLinks = appLinks;
  const geocoder = new Geocoder({ url: config.NIBBLET_GEOCODER_URL, version: VERSION });
  const locations = new LocationRequests({ store, geocoder, viewers: () => bus.viewers });
  conductor.locations = locations;
  const borrow = new Borrow({
    store,
    docker,
    machines,
    config,
    stop: (nibbletId) => conductor.stop(nibbletId),
    start: (nibbletId) => conductor.start(nibbletId),
    publish: (message) => bus.publish(message),
  });
  conductor.borrowed = (nibbletId) => borrow.borrowed(nibbletId);
  const scheduler = new Scheduler(store, conductor);
  const snapshots = new Snapshots({
    store,
    bus,
    homes: conductor,
    conductor,
    scheduler,
    dataDir: config.NIBBLET_DATA_DIR,
  });
  const harnessUpdates = new HarnessUpdater({ store, docker, log: (m) => console.log(m) });
  const appUpdates = new AppUpdater({
    config,
    version: VERSION,
    pause: () => conductor.pauseForUpdate(),
    unpause: () => conductor.unpause(),
  });
  const central = new Connect({
    store,
    tunnel,
    config,
    version: VERSION,
    serverName: () => serverName(store, config.NIBBLET_HOST_NAME),
    nibbletCount: async () => (await store.listNibblets()).length,
    tailscaleUrl: async () => (await tailscaleStatus(config)).url,
  });

  // A nibblet needing its person reaches their phone, through Connect.
  const notifier = new Notifier((note) => void central.notify(note));
  bus.subscribe((message) => notifier.observe(message));

  const app = createApp(
    {
      notifier,
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
      harnessUpdates,
      appUpdates,
      bank,
      banks,
      appLinks,
      geocoder,
      locations,
      publicAddress,
      machines,
      borrow,
    },
    bus,
  );
  // Offered to every socket, but a message is deflated only when it's sent
  // with `compress: true`: the live feed and terminals are, while the browser
  // view's frames (already-compressed images) and runners' messages aren't.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
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
  await locations.resetStale();
  await scheduler.start();
  snapshots.start();
  if (config.NIBBLET_HARNESS_UPDATES) harnessUpdates.start();
  bank.start();
  appLinks.start();
  // An update leaves the last release's images behind; reconcile has just
  // moved running nibblets off them. Again daily, for those that were stopped.
  const prune = () =>
    void docker.pruneImages().then(
      (removed) => {
        if (removed.length) console.log(`removed old images: ${removed.join(", ")}`);
      },
      (err: unknown) => console.error("couldn't remove old images", err),
    );
  const pruning = config.NIBBLET_PRUNE_IMAGES ? setInterval(prune, 24 * 60 * 60_000) : undefined;
  if (config.NIBBLET_PRUNE_IMAGES) prune();
  // Budget waits end when the month turns, or when a setting changes here;
  // this catches the rest, such as the proxy going back to a subscription.
  const budgetSweep = setInterval(() => void conductor.recheckBudgetWaits(), 5 * 60_000);
  // The tunnel follows the Connect link: on with it, off without.
  await central.restore();

  const shutdown = () => {
    // Closes any borrowed window on the host; nothing is handed back.
    borrow.abortAll();
    scheduler.stop();
    snapshots.stop();
    harnessUpdates.stop();
    bank.stop();
    appLinks.stop();
    clearInterval(pruning);
    clearInterval(budgetSweep);
    central.stop();
    tunnel.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
