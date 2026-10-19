import { useEffect, useRef } from "react";
import { type Nibblet, type StoredItem } from "@nibblet/protocol";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useServers, keys } from "./servers.tsx";
import { useOffline } from "./offline-context.tsx";
import { conversationKey, saveConversation, type OfflinePayload } from "./offline-data.ts";
import { drainHead, type DrainWake } from "./offline-outbox.ts";
import type { ServerConnection } from "./connection.ts";

/** How long chat updates gather before they're saved in one encrypted write. */
export const SNAPSHOT_DELAY_MS = 1_500;
/** How long a host's identity is reused before a save asks it again. */
const HOST_CHECK_MS = 60_000;

export function OfflineBridge() {
  const servers = useServers();
  const offline = useOffline();
  const latest = useRef(offline);
  latest.current = offline;
  const qc = useQueryClient();
  useSnapshots(qc, servers, offline);
  const previousQueued = useRef(new Map<string, string>());
  const observedOpen = useRef(new WeakSet<ServerConnection>());
  const retryWakes = useRef(new WeakMap<ServerConnection, Map<string, "idle" | "reconnect">>());
  useEffect(() => {
    let alive = true;
    const active = new Set<string>();
    if (!offline.vault?.unlocked) {
      retryWakes.current = new WeakMap();
      observedOpen.current = new WeakSet();
    }
    const wakesFor = (connection: ServerConnection) => {
      let wakes = retryWakes.current.get(connection);
      if (!wakes) {
        wakes = new Map();
        retryWakes.current.set(connection, wakes);
      }
      return wakes;
    };
    const wakePending = new Set<string>();
    const drain = async (server: string, id: string) => {
      const current = latest.current;
      const vault = current.vault;
      const connection = servers.byId(server);
      const key = conversationKey(server, id);
      if (!vault?.unlocked || !connection) return;
      const retryWake = wakesFor(connection);
      if (active.has(key)) {
        wakePending.add(key);
        return;
      }
      active.add(key);
      let progressed = false;
      try {
        progressed = await drainHead(
          vault,
          connection,
          id,
          retryWake.get(key) ?? "queue",
          () => alive,
          current.mutate,
          () => {
            retryWake.delete(key);
          },
        );
        if (progressed) await qc.invalidateQueries({ queryKey: keys.thread(server, id) });
      } finally {
        active.delete(key);
        const wake = wakePending.delete(key);
        if ((progressed || wake) && alive && vault.unlocked)
          queueMicrotask(() => {
            void drain(server, id).catch(latest.current.report);
          });
      }
    };
    const run = (server: string, wake: DrainWake, conversation?: string) => {
      const connection = servers.byId(server);
      if (!connection) return;
      const retryWake = wakesFor(connection);
      const pending = latest.current.payload.outbox.filter(
        (m) =>
          m.server === server &&
          (!conversation || m.conversation === conversation) &&
          (m.state === "queued" || m.state === "uncertain"),
      );
      for (const id of new Set(pending.map((m) => m.conversation))) {
        const key = conversationKey(server, id);
        if (wake !== "queue" && retryWake.get(key) !== "reconnect") retryWake.set(key, wake);
        void drain(server, id).catch(latest.current.report);
      }
    };
    const cleanups = servers.all.flatMap((connection) => [
      connection.live.onState((state) => {
        if (state !== "open") observedOpen.current.delete(connection);
        if (
          state === "open" &&
          latest.current.vault?.unlocked &&
          !observedOpen.current.has(connection)
        ) {
          observedOpen.current.add(connection);
          run(connection.id, "reconnect");
        }
      }),
      connection.live.onReconnect(() => run(connection.id, "reconnect")),
      connection.live.subscribe((message) => {
        if (message.type === "nibblet" && message.nibblet.status !== "working")
          run(connection.id, "idle", message.nibblet.id);
        if (message.type === "snapshots_changed" && message.activity === null)
          run(connection.id, "idle", message.nibbletId);
      }),
    ]);
    const outboxChanged = () => {
      for (const connection of servers.all) run(connection.id, "queue");
    };
    window.addEventListener("nibblets-outbox-changed", outboxChanged);
    for (const connection of servers.all) run(connection.id, "queue");
    return () => {
      alive = false;
      cleanups.forEach((off) => off());
      window.removeEventListener("nibblets-outbox-changed", outboxChanged);
    };
  }, [servers, qc, offline.vault?.unlocked]);
  useEffect(() => {
    const queued = new Map(
      offline.payload.outbox
        .filter((message) => message.state === "queued" && !message.attempted)
        .map((message) => [message.id, message.text]),
    );
    if ([...queued].some(([id, text]) => previousQueued.current.get(id) !== text))
      window.dispatchEvent(new Event("nibblets-outbox-changed"));
    previousQueued.current = queued;
  }, [offline.payload.outbox]);
  return null;
}

/**
 * Saves open chats into the vault as their queries change. Streaming fires
 * an update per item, so changes gather for SNAPSHOT_DELAY_MS and go in one
 * write; what's waiting is written straight away when the page is hidden
 * or the vault is about to lock.
 */
function useSnapshots(
  qc: QueryClient,
  servers: ReturnType<typeof useServers>,
  offline: ReturnType<typeof useOffline>,
): void {
  const latest = useRef({ servers, offline });
  latest.current = { servers, offline };
  const { vault, beforeLock } = offline;
  const unlocked = vault?.unlocked ?? false;
  useEffect(() => {
    if (!vault || !unlocked) return;
    const dirty = new Map<string, { server: string; id: string }>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writing = Promise.resolve();

    const flushNow = () => void flush().catch(latest.current.offline.report);
    const mark = (server: string, id: string) => {
      dirty.set(conversationKey(server, id), { server, id });
      timer ??= setTimeout(flushNow, SNAPSHOT_DELAY_MS);
    };
    const markServer = (server: string) => {
      for (const [key] of qc.getQueriesData({ queryKey: ["thread", server] }))
        if (typeof key[2] === "string") mark(server, key[2]);
    };
    // One write at a time, each taking whatever has gathered since the last.
    const flush = (): Promise<void> => {
      if (timer) clearTimeout(timer);
      timer = null;
      writing = writing.then(write, write);
      return writing;
    };
    const write = async (): Promise<void> => {
      const { servers, offline } = latest.current;
      if (!dirty.size || !vault.unlocked) return;
      const wanted = [...dirty.values()];
      dirty.clear();
      const failures: Error[] = [];
      const saves = await Promise.all(
        wanted.map(async ({ server, id }) => {
          const connection = servers.byId(server);
          const nibblet = qc
            .getQueryData<Nibblet[]>(keys.nibblets(server))
            ?.find((n) => n.id === id);
          const items = qc.getQueryData<StoredItem[]>(keys.thread(server, id));
          if (!connection || !nibblet || !items) return [];
          try {
            const info = await qc.fetchQuery({
              queryKey: keys.info(server),
              queryFn: () => connection.client.system.info({}),
              staleTime: HOST_CHECK_MS,
            });
            const name = servers.system(server)?.name ?? info.name;
            return [{ server, nibblet, items, host: info.serverId, name }];
          } catch (failure) {
            failures.push(failure instanceof Error ? failure : new Error(String(failure)));
            return [];
          }
        }),
      );
      const ready = saves.flat();
      if (ready.length && vault.unlocked)
        await offline.mutate((data) =>
          ready.reduce<OfflinePayload>((payload, save) => {
            const bound = payload.bindings[save.server];
            if (bound && bound !== save.host) {
              failures.push(
                new Error("This route points to a different host. Saved messages were not sent."),
              );
              return payload;
            }
            return saveConversation(
              { ...payload, bindings: { ...payload.bindings, [save.server]: save.host } },
              save.server,
              save.host,
              save.name,
              save.nibblet,
              save.items,
            );
          }, data),
        );
      if (failures[0]) throw failures[0];
    };

    const offQuery = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const [type, server, id] = event.query.queryKey;
      if (type === "thread" && typeof server === "string" && typeof id === "string")
        mark(server, id);
      if (type === "nibblets" && typeof server === "string") markServer(server);
    });
    const hidden = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flushNow);
    const offLock = beforeLock(flush);
    for (const [key] of qc.getQueriesData({ queryKey: ["thread"] }))
      if (typeof key[1] === "string" && typeof key[2] === "string") mark(key[1], key[2]);
    return () => {
      offQuery();
      offLock();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flushNow);
      // Whatever has gathered still goes, if the vault is open to take it.
      if (dirty.size) flushNow();
      else if (timer) clearTimeout(timer);
    };
  }, [qc, vault, unlocked, beforeLock]);
}
