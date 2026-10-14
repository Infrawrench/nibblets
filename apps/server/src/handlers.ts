import {
  contract,
  CredentialStatus,
  type HarnessId,
  mergeMcpServers,
  RpcError,
  ServerInfo,
  type Contract,
  type Handlers,
} from "@nibblet/protocol";
import { z } from "zod";
import { cliStatuses } from "./clilogins.ts";
import type { Conductor } from "./conductor.ts";
import type { HarnessModelLists } from "./opencode.ts";
import {
  dropOverlaps,
  hostTools,
  setTailscale,
  tailscaleLogin,
  tailscaleStatus,
} from "./hostmcp.ts";
import type { Config } from "./config.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";
import type { Connect } from "./connect.ts";
import type { Tunnel } from "./tunnel.ts";

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
    return (["anthropic", "openai"] as const).map((provider) => ({
      provider,
      source: "none",
      ok: false,
      detail,
      plan: null,
      expiresAt: null,
    }));
  }
}

export function serverName(store: Store): Promise<string> {
  return store.getSetting("name", (v) => z.string().parse(v), "My nibblets");
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
          name: await serverName(store),
          version: s.version,
          credentials: await credentialStatus(s.config),
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
        const { mcpServers, ...rest } = patch;
        const row = await store.nibbletRow(id);
        let merged = mcpServers ? mergeMcpServers(mcpServers, row.mcpServers) : null;
        // Ticking a host tool retires the nibblet's own copy of the same server.
        const enabled = patch.hostTools ?? row.hostTools;
        if (enabled.length > 0 && (merged ?? row.mcpServers).length > 0) {
          const host = await hostTools(s.config);
          const kept = dropOverlaps(merged ?? row.mcpServers, enabled, host.servers);
          if (kept.length !== (merged ?? row.mcpServers).length) merged = kept;
        }
        const updated = await store.updateNibblet(id, {
          ...rest,
          ...(merged ? { mcpServers: merged } : {}),
          // A different harness can't resume the old one's session.
          ...(harnessChanged ? { harnessSessionId: null } : {}),
        });
        // The browser and the SSH agent are fixed when the container is made.
        const sshBefore = before.cliCredentials.includes("ssh");
        const sshAfter = (patch.cliCredentials ?? before.cliCredentials).includes("ssh");
        const needsRestart =
          (patch.browser !== undefined && patch.browser !== before.browser) ||
          sshBefore !== sshAfter;
        if (needsRestart && before.status !== "stopped") return conductor.start(id);
        await conductor.reconfigure(id);
        return updated;
      },
      delete: async ({ id }) => {
        await conductor.delete(id);
        return ok;
      },
      start: ({ id }) => conductor.start(id),
      stop: ({ id }) => conductor.stop(id),
      send: async ({ id, text }) => {
        await conductor.enqueue(id, "user", text);
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

    tailscale: {
      status: () => tailscaleStatus(s.config),
      set: ({ serving }) => setTailscale(s.config, serving),
      login: () => tailscaleLogin(s.config),
    },

    hostTools: {
      list: () => hostTools(s.config),
    },

    clis: {
      list: () => cliStatuses(s.config),
    },

    auth: {
      createPairingLink: async () => {
        const { code, expiresAt } = await store.createPairingCode(15 * 60_000);
        return { url: `${tunnel.publicUrl()}/#pair=${code}`, expiresAt: expiresAt.toISOString() };
      },
    },
  };
}

export { contract };
