import {
  contract,
  CredentialStatus,
  type HarnessId,
  mergeMcpServers,
  mergeTailscale,
  RpcError,
  ServerInfo,
  type Contract,
  type Handlers,
} from "@nibblet/protocol";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliStatuses } from "./clilogins.ts";
import { readTailnetOAuth, setTailnetKeys, tailnetKeys } from "./tailnet-keys.ts";
import { forgetGrants, onePasswordStatus, readGrants, setGrants } from "./onepassword.ts";
import type { Bank } from "./bank.ts";
import type { Banks } from "./banks.ts";
import type { PublicAddresses } from "./public-address.ts";
import type { MachineRegistry } from "@nibblet/machine";
import type { Conductor } from "./conductor.ts";
import type { Borrow } from "./borrow.ts";
import type { HarnessModelLists } from "./opencode.ts";
import {
  dropOverlaps,
  hostTools,
  setTailscale,
  tailscaleLogin,
  tailscaleStatus,
} from "./hostmcp.ts";
import type { Config } from "./config.ts";
import type { Notifier } from "./notifier.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Snapshots } from "./snapshots.ts";
import type { Files } from "./files.ts";
import type { Geocoder } from "./geocode.ts";
import { toLocation, type LocationRequests } from "./location-requests.ts";
import type { Store } from "./store.ts";
import type { Connect } from "./connect.ts";
import type { Tunnel } from "./tunnel.ts";
import type { AppUpdater, HarnessUpdater } from "./updates.ts";

export interface Services {
  config: Config;
  store: Store;
  conductor: Conductor;
  scheduler: Scheduler;
  tunnel: Tunnel;
  connect: Connect;
  models: HarnessModelLists;
  serverId: string;
  version: string;
  files: Files;
  snapshots: Snapshots;
  notifier: Notifier;
  harnessUpdates: HarnessUpdater;
  appUpdates: AppUpdater;
  bank: Bank;
  banks: Banks;
  geocoder: Geocoder;
  locations: LocationRequests;
  publicAddress: PublicAddresses;
  machines: MachineRegistry;
  borrow: Borrow;
}

const ok = { ok: true } as const;

async function credentialStatus(config: Config): Promise<CredentialStatus[]> {
  try {
    const res = await fetch(`${config.CREDPROXY_URL}/status`, {
      headers: { authorization: `Bearer ${config.CREDPROXY_ADMIN_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return z.array(CredentialStatus).parse(await res.json());
  } catch (err) {
    const detail = `Credential proxy unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return (["anthropic", "openai", "deepseek"] as const).map((provider) => ({
      provider,
      source: "none",
      ok: false,
      detail,
      plan: null,
      expiresAt: null,
      limitedUntil: null,
    }));
  }
}

/** What the server is called: the name it was given, or else the computer's own name. */
export function serverName(store: Store, hostName: string): Promise<string> {
  const machine = hostName.replace(/\.local$/, "").trim() || "My nibblets";
  return store.getSetting("name", (v) => z.string().parse(v), machine);
}

export function createHandlers(s: Services): Handlers<Contract, Record<string, never>> {
  const { store, conductor, scheduler, tunnel } = s;

  const checkModel = async (harness: HarnessId, model: string) => {
    if (!(await s.models.accepts(harness, model)))
      throw new RpcError("bad_request", `${model} isn't a ${harness} model`);
  };

  return {
    system: {
      info: async () =>
        ServerInfo.parse({
          serverId: s.serverId,
          name: await serverName(store, s.config.NIBBLET_HOST_NAME),
          version: s.version,
          credentials: await credentialStatus(s.config),
          host: await s.conductor.hostCapacity(),
        }),
      rename: async ({ name }) => {
        await store.setSetting("name", name);
        conductor.serverName = name;
        return ok;
      },
    },

    nibblets: {
      list: () => store.listNibblets(),
      get: ({ id }) => store.getNibblet(id),
      create: async ({ message, ...input }) => {
        await checkModel(input.harness, input.model);
        await s.machines.check(input.machine).catch((err: unknown) => {
          throw new RpcError("bad_request", err instanceof Error ? err.message : String(err));
        });
        if (input.windowsProductKey && input.machine?.guest !== "windows") {
          throw new RpcError("bad_request", "A Windows product key is only for a Windows machine");
        }
        if (input.mcpServers?.length && input.hostTools?.length) {
          const host = await hostTools(s.config);
          input = {
            ...input,
            mcpServers: dropOverlaps(input.mcpServers, input.hostTools, host.servers),
          };
        }
        const { nibblet } = await store.createNibblet(input, null);
        if (message) await conductor.enqueue(nibblet.id, "user", message);
        else await conductor.start(nibblet.id);
        return store.getNibblet(nibblet.id);
      },
      update: async ({ id, ...patch }) => {
        const before = await store.getNibblet(id);
        const harness = patch.harness ?? before.harness;
        const model = patch.model ?? before.model;
        await checkModel(harness, model);
        const harnessChanged = harness !== before.harness;
        const { mcpServers, tailscale: tailscalePatch, location: fix, ...rest } = patch;
        const row = await store.nibbletRow(id);
        const tailscale =
          tailscalePatch === undefined
            ? undefined
            : tailscalePatch && mergeTailscale(tailscalePatch, row.tailscale);
        if (tailscale && before.parentId)
          throw new RpcError(
            "bad_request",
            "A sub-agent is on the tailnet as its parent's machine",
          );
        if (patch.monthlyBudgetUsd != null && before.parentId)
          throw new RpcError("bad_request", "A sub-agent spends its parent's budget");
        if (tailscale && !conductor.capabilities(row).tailscale)
          throw new RpcError("bad_request", "Its machine can't join a tailnet yet");
        if (tailscale && !tailscale.authKey && !(await readTailnetOAuth(store)))
          throw new RpcError(
            "bad_request",
            "Paste an auth key, or set up an OAuth client in Settings to make them",
          );
        let merged = mcpServers ? mergeMcpServers(mcpServers, row.mcpServers) : null;
        // Ticking a host tool retires the nibblet's own copy of the same server.
        const enabled = patch.hostTools ?? row.hostTools;
        if (enabled.length > 0 && (merged ?? row.mcpServers).length > 0) {
          const host = await hostTools(s.config);
          const kept = dropOverlaps(merged ?? row.mcpServers, enabled, host.servers);
          if (kept.length !== (merged ?? row.mcpServers).length) merged = kept;
        }
        // The place is looked up here, so what the nibblet's told comes from one source.
        const location = fix && (await toLocation(s.geocoder, fix));
        const updated = await store.updateNibblet(id, {
          ...rest,
          ...(merged ? { mcpServers: merged } : {}),
          ...(tailscale !== undefined ? { tailscale } : {}),
          ...(location !== undefined ? { location } : {}),
          // A different harness can't resume the old one's session.
          ...(harnessChanged ? { harnessSessionId: null } : {}),
        });
        // A raised budget, or a move off the API key it was spent on, lets
        // whatever waits on it carry on; before a restart, which returns early.
        if (patch.monthlyBudgetUsd !== undefined || harnessChanged || model !== before.model)
          await conductor.recheckBudgetWaits(id);
        // The browser, the SSH agent and Tailscale are fixed when the container is made.
        const sshBefore = before.cliCredentials.includes("ssh");
        const sshAfter = (patch.cliCredentials ?? before.cliCredentials).includes("ssh");
        // Deeply, since Postgres hands jsonb back with its keys in its own order.
        const tailscaleChanged =
          tailscale !== undefined && !isDeepStrictEqual(tailscale, row.tailscale);
        const needsRestart =
          (patch.browser !== undefined && patch.browser !== before.browser) ||
          sshBefore !== sshAfter ||
          tailscaleChanged;
        if (needsRestart && before.status !== "stopped") return conductor.start(id);
        // Asleep, it signs its machine out now rather than whenever it next wakes.
        if (tailscaleChanged && tailscale === null) void conductor.leaveTailnet(id);
        if (patch.resources) await conductor.applyResources(id, patch.resources);
        await conductor.reconfigure(id);
        return updated;
      },
      delete: async ({ id }) => {
        await conductor.delete(id);
        await forgetGrants(s.config, store, id);
        return ok;
      },
      start: ({ id }) => {
        if (s.borrow.borrowed(id))
          throw new RpcError(
            "unavailable",
            "It's signed in locally right now — hand it back first.",
          );
        return conductor.start(id);
      },
      stop: ({ id }) => conductor.stop(id),
      logs: async ({ id, lines }) => ({ text: await conductor.logs(id, lines ?? 200) }),
      send: async ({ id, text, attachments }) => {
        const files = await s.files.attachments(id, attachments);
        await conductor.enqueue(id, "user", text, files);
        return ok;
      },
      interrupt: async ({ id }) => {
        conductor.interrupt(id);
        return ok;
      },
      wake: async ({ id }) => {
        await conductor.heartbeat(id);
        return ok;
      },
      spend: ({ id }) => conductor.budgets.status(id),
      resume: async ({ id }) => {
        await conductor.resumeNow(id);
        return ok;
      },
      tasks: async ({ id }) => conductor.terminals.tasksOf(id),
      apps: async ({ id }) => {
        conductor.terminals.scanApps(id);
        return conductor.terminals.appsOf(id);
      },
      stopTask: async ({ id, taskId }) => {
        if (!conductor.terminals.stopTask(id, taskId))
          throw new RpcError("bad_request", "It isn't running");
        return ok;
      },
      answerLocation: async ({ id, requestId, location }) => {
        await s.locations.answer(id, requestId, location);
        return ok;
      },
      browserBorrowStart: ({ id }) => s.borrow.start(id),
      browserBorrowEnd: ({ id }) => s.borrow.end(id),
      browserBorrow: async ({ id }) => s.borrow.current(id),
      decide: async ({ id, approvalId, approve, reason }) => {
        await conductor.approvals.decide(id, approvalId, approve, reason);
        return ok;
      },
    },

    machines: {
      list: () => s.machines.describe(),
      prepare: async ({ backend, guest, source }) => {
        await s.machines.check({ backend, guest }).catch((err: unknown) => {
          throw new RpcError("bad_request", err instanceof Error ? err.message : String(err));
        });
        await s.machines.get({ backend }).prepare(guest, source);
        return ok;
      },
    },

    harnesses: {
      models: ({ harness }) => s.models.list(harness),
    },

    thread: {
      items: ({ nibbletId, sinceSeq }) => store.itemsSince(nibbletId, sinceSeq),
    },

    schedules: {
      list: ({ nibbletId }) => scheduler.describe(nibbletId),
      create: async (input) => {
        await store.getNibblet(input.nibbletId);
        const row = await store.createSchedule({
          nibbletId: input.nibbletId,
          name: input.name,
          cron: input.cron,
          runAt: input.runAt ? new Date(input.runAt) : null,
          timezone: input.timezone,
          prompt: input.prompt,
        });
        await scheduler.arm(row.id);
        return store.toSchedule(row, scheduler.nextRun(row.id));
      },
      setEnabled: async ({ id, enabled }) => {
        const row = await store.updateSchedule(id, { enabled });
        await scheduler.arm(id);
        return store.toSchedule(row, scheduler.nextRun(id));
      },
      delete: async ({ id }) => {
        scheduler.disarm(id);
        await store.deleteSchedule(id);
        return ok;
      },
    },

    memories: {
      list: ({ nibbletId, query }) => store.searchMemories({ nibbletId, query, limit: 50 }),
      create: ({ nibbletId, content, tags }) => store.saveMemory({ nibbletId, content, tags }),
      delete: async ({ id }) => {
        await store.deleteMemory(id);
        return ok;
      },
    },

    bank: {
      status: () => s.banks.status(),
      cards: ({ nibbletId }) => s.bank.cards(nibbletId),
      allowances: ({ nibbletId }) => s.bank.allowances(nibbletId),
      kill: ({ id }) => s.bank.kill(id, "user"),
      configure: (change) => s.banks.configure(change),
      remove: ({ id }) => s.banks.remove(id),
    },
    snapshots: {
      list: ({ nibbletId }) => s.snapshots.list(nibbletId),
      create: ({ nibbletId, label }) => s.snapshots.create(nibbletId, label ?? null),
      restore: async ({ id }) => {
        await s.snapshots.restore(id);
        return ok;
      },
      rename: ({ id, label }) => s.snapshots.rename(id, label),
      delete: async ({ id }) => {
        await s.snapshots.delete(id);
        return ok;
      },
    },

    connect: {
      status: async () => s.connect.status(),
      start: async () => {
        try {
          return await s.connect.start();
        } catch (err) {
          throw new RpcError("unavailable", err instanceof Error ? err.message : String(err));
        }
      },
      cancel: async () => s.connect.cancel(),
      unlink: () => s.connect.unlink(),
    },

    publicAddress: {
      status: () => s.publicAddress.current(),
      setProxy: ({ url }) => s.publicAddress.setProxy(url),
    },

    tailscale: {
      status: () => tailscaleStatus(s.config),
      set: ({ serving }) => setTailscale(s.config, serving),
      login: () => tailscaleLogin(s.config),
      keys: () => tailnetKeys(store),
      setKeys: (input) => setTailnetKeys(store, input),
    },

    hostTools: {
      list: () => hostTools(s.config),
    },

    updates: {
      harnesses: () => s.harnessUpdates.status(),
      check: () => s.harnessUpdates.check(),
      updateHarness: ({ id }) => s.harnessUpdates.update(id),
      useBundled: ({ id }) => s.harnessUpdates.useBundled(id),
      setAuto: ({ auto }) => s.harnessUpdates.setAuto(auto),
      app: ({ refresh }) => s.appUpdates.status(refresh),
      applyApp: async () => {
        try {
          return await s.appUpdates.apply();
        } catch (err) {
          throw new RpcError("unavailable", err instanceof Error ? err.message : String(err));
        }
      },
    },

    clis: {
      list: () => cliStatuses(s.config),
    },

    onePassword: {
      status: () => onePasswordStatus(s.config),
      grants: () => readGrants(store),
      setGrants: async ({ nibbletId, grants }) => {
        const nibblet = await store.getNibblet(nibbletId);
        const all = await setGrants(s.config, store, nibblet, grants);
        // A running nibblet picks the change up straight away.
        await conductor.reconfigure(nibbletId);
        return all;
      },
    },

    auth: {
      createPairingLink: async () => {
        const { code, expiresAt } = await store.createPairingCode(15 * 60_000);
        const reached = (await s.publicAddress.current()).url ?? s.config.NIBBLET_PUBLIC_URL;
        return { url: `${reached}/#pair=${code}`, expiresAt: expiresAt.toISOString() };
      },
    },
  };
}

export { contract };
