import { useEffect, useRef } from "react";
import { type Nibblet, type StoredItem } from "@nibblet/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useServers, keys } from "./servers.tsx";
import { useOffline } from "./offline-context.tsx";
import { conversationKey, saveConversation } from "./offline-data.ts";
import { drainHead } from "./offline-outbox.ts";

export function OfflineBridge() {
  const servers = useServers();
  const offline = useOffline();
  const latest = useRef(offline);
  latest.current = offline;
  const qc = useQueryClient();
  const previousQueued = useRef(new Map<string, string>());
  useEffect(() => {
    let alive = true;
    const active = new Set<string>();
    const reconnected = new Set<string>();
    const wakePending = new Set<string>();
    const snapshot = async (server: string, id: string) => {
      const current = latest.current;
      if (!current.vault?.unlocked) return;
      const connection = servers.byId(server);
      if (!connection) return;
      const nibblet = qc.getQueryData<Nibblet[]>(keys.nibblets(server))?.find((n) => n.id === id);
      const items = qc.getQueryData<StoredItem[]>(keys.thread(server, id));
      if (!nibblet || !items) return;
      const info = await connection.client.system.info({});
      if (!alive || !current.vault.unlocked) return;
      await current.mutate((data) => {
        const bound = data.bindings[server];
        if (bound && bound !== info.serverId)
          throw new Error("This route points to a different host. Saved messages were not sent.");
        return saveConversation(
          { ...data, bindings: { ...data.bindings, [server]: info.serverId } },
          server,
          info.serverId,
          servers.system(server)?.name ?? info.name,
          nibblet,
          items,
        );
      });
    };
    const drain = async (server: string, id: string, reconnect: boolean) => {
      const current = latest.current;
      const vault = current.vault;
      const connection = servers.byId(server);
      const key = conversationKey(server, id);
      if (!vault?.unlocked || !connection) return;
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
          reconnect || reconnected.has(key),
          () => alive,
          current.mutate,
          () => {
            reconnected.delete(key);
          },
        );
        if (progressed) await qc.invalidateQueries({ queryKey: keys.thread(server, id) });
      } finally {
        active.delete(key);
        const wake = wakePending.delete(key);
        if ((progressed || wake) && alive && vault.unlocked)
          queueMicrotask(() => {
            void drain(server, id, false).catch(latest.current.report);
          });
      }
    };
    const run = (server: string, reconnect: boolean) => {
      const pending = latest.current.payload.outbox.filter(
        (m) => m.server === server && (m.state === "queued" || m.state === "uncertain"),
      );
      for (const id of new Set(pending.map((m) => m.conversation))) {
        if (reconnect) reconnected.add(conversationKey(server, id));
        void drain(server, id, reconnect).catch(latest.current.report);
      }
    };
    const offQuery = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const [type, server, id] = event.query.queryKey;
      if (type === "thread" && typeof server === "string" && typeof id === "string")
        void snapshot(server, id).catch(latest.current.report);
      if (type === "nibblets" && typeof server === "string")
        for (const [key] of qc.getQueriesData({ queryKey: ["thread", server] })) {
          if (typeof key[2] === "string")
            void snapshot(server, key[2]).catch(latest.current.report);
        }
    });
    const cleanups = servers.all.flatMap((connection) => [
      connection.live.onState((state) => {
        if (state === "open") run(connection.id, true);
      }),
      connection.live.onReconnect(() => run(connection.id, true)),
      connection.live.subscribe((message) => {
        if (message.type === "nibblet" && message.nibblet.status !== "working")
          run(connection.id, false);
      }),
    ]);
    const outboxChanged = () => {
      for (const connection of servers.all) run(connection.id, false);
    };
    window.addEventListener("nibblets-outbox-changed", outboxChanged);
    for (const connection of servers.all) run(connection.id, false);
    for (const [key] of qc.getQueriesData({ queryKey: ["thread"] })) {
      if (typeof key[1] === "string" && typeof key[2] === "string")
        void snapshot(key[1], key[2]).catch(latest.current.report);
    }
    return () => {
      alive = false;
      offQuery();
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
