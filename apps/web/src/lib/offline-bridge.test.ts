// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://offline.example"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { BroadcastChannel } from "node:worker_threads";
import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StoredItem } from "@nibblet/protocol";
import { OfflineVault } from "./offline-vault.ts";
import { emptyOfflinePayload, OfflinePayload, saveConversation } from "./offline-data.ts";
import { createMockServer } from "./mock.ts";
import { OfflineBridge, SNAPSHOT_DELAY_MS } from "./offline-bridge.tsx";
import { useOffline } from "./offline-context.tsx";
import { keys, useServers } from "./servers.tsx";
import { upsertItems } from "./thread.ts";

const shared = vi.hoisted(() => {
  const state: {
    offline: ReturnType<typeof useOffline> | null;
    servers: ReturnType<typeof useServers> | null;
  } = { offline: null, servers: null };
  return state;
});
vi.mock("./offline-context.tsx", async (original) => ({
  ...(await original<typeof import("./offline-context.tsx")>()),
  useOffline: () => {
    if (!shared.offline) throw new Error("Missing test vault");
    return shared.offline;
  },
}));
vi.mock("./servers.tsx", async (original) => ({
  ...(await original<typeof import("./servers.tsx")>()),
  useServers: () => {
    if (!shared.servers) throw new Error("Missing test server");
    return shared.servers;
  },
}));

let root: Root;
let client: QueryClient;
let vault: OfflineVault;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map<string, Promise<void>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(key: string, fn: () => Promise<T>): Promise<T> => {
        const operation = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
        locks.set(
          key,
          operation.then(
            () => undefined,
            () => undefined,
          ),
        );
        return operation;
      },
    },
  });
  root = createRoot(document.createElement("div"));
  client = new QueryClient();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vault.close();
  shared.offline = null;
  shared.servers = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  vault = await OfflineVault.open("bridge-tests", OfflinePayload);
  await vault.create("test recovery passphrase");
  const mutate = vi.fn(async (fn: (data: OfflinePayload) => OfflinePayload) =>
    vault.update("payload", (old) => fn(old ?? emptyOfflinePayload())),
  );
  const flushes = new Set<() => Promise<void>>();
  shared.offline = {
    vault,
    payload: emptyOfflinePayload(),
    mutate,
    error: null,
    report: vi.fn(),
    enqueue: async () => undefined,
    beforeLock: (flush) => {
      flushes.add(flush);
      return () => flushes.delete(flush);
    },
  };
  const connection = createMockServer();
  const info = vi.spyOn(connection.client.system, "info");
  const system = {
    id: connection.id,
    name: "host",
    platform: null,
    local: true,
    online: true,
    route: null,
    connection,
  };
  shared.servers = {
    all: [connection],
    systems: [system],
    byId: () => connection,
    system: () => system,
    central: null,
  };
  const nibblets = await connection.client.nibblets.list({});
  const nibblet = nibblets[0]!;
  const items = await connection.client.thread.items({ nibbletId: nibblet.id, sinceSeq: 0 });
  client.setQueryData(keys.nibblets(connection.id), nibblets);
  client.setQueryData<StoredItem[]>(keys.thread(connection.id, nibblet.id), []);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge))),
  );
  // The live feed, one item at a time, with the nibblet list refreshed alongside each.
  const stream = async () => {
    await act(async () => {
      for (const item of items) {
        client.setQueryData<StoredItem[]>(keys.thread(connection.id, nibblet.id), (old) =>
          upsertItems(old ?? [], [item]),
        );
        client.setQueryData(keys.nibblets(connection.id), [...nibblets]);
      }
    });
  };
  const saved = async () => (await vault.read("payload"))?.conversations[0]?.messages.length;
  // Every message in the stream, as the vault should end up holding it.
  const whole = saveConversation(emptyOfflinePayload(), "", "", "", nibblet, items);
  const expected = whole.conversations[0]?.messages.length;
  return { mutate, info, flushes, stream, saved, expected };
}

it("saves a burst of chat updates in one write", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await mount();
  await f.stream();
  expect(f.mutate).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(SNAPSHOT_DELAY_MS));
  await vi.waitFor(async () => expect(await f.saved()).toBe(f.expected));
  await act(async () => vi.advanceTimersByTimeAsync(SNAPSHOT_DELAY_MS * 2));
  expect(f.mutate).toHaveBeenCalledOnce();
  expect(f.info).toHaveBeenCalledOnce();
});

it("writes what's waiting straight away before the vault locks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await mount();
  await f.stream();
  await act(async () => {
    await Promise.all([...f.flushes].map((flush) => flush()));
  });
  expect(f.mutate).toHaveBeenCalledOnce();
  expect(await f.saved()).toBe(f.expected);
});
