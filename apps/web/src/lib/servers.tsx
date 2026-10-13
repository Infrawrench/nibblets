import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { LiveMessage, Nibblet, Peer, StoredItem } from "@nibblet/protocol";
import { createConnection, type LiveState, type ServerConnection } from "./connection.ts";
import { maxSeq, upsertItems } from "./thread.ts";

/** Query keys, in one place so the live bridge and the hooks agree. */
export const keys = {
  info: (server: string) => ["info", server] as const,
  nibblets: (server: string) => ["nibblets", server] as const,
  thread: (server: string, id: string) => ["thread", server, id] as const,
  schedules: (server: string, id: string) => ["schedules", server, id] as const,
  memories: (server: string, id: string | null, query: string) =>
    ["memories", server, id, query] as const,
  peers: () => ["peers"] as const,
  tunnel: () => ["tunnel"] as const,
  hostTools: (server: string) => ["hostTools", server] as const,
  clis: (server: string) => ["clis", server] as const,
};

interface Servers {
  local: ServerConnection;
  /** This server first, then each peer. */
  all: ServerConnection[];
  peers: Peer[];
  byId(id: string): ServerConnection | undefined;
}

const ServersContext = createContext<Servers | null>(null);

export function useServers(): Servers {
  const value = useContext(ServersContext);
  if (!value) throw new Error("useServers outside ServersProvider");
  return value;
}

export function useServer(id: string): ServerConnection | undefined {
  return useServers().byId(id);
}

export function ServersProvider({
  local,
  connectPeers = true,
  children,
}: {
  local: ServerConnection;
  /** Off in mock mode, where peers are fixtures with nothing behind them. */
  connectPeers?: boolean;
  children: ReactNode;
}) {
  const peersQuery = useQuery({
    queryKey: keys.peers(),
    queryFn: () => local.client.peers.list({}),
  });
  const peers = peersQuery.data ?? [];
  const peerKey = peers.map((p) => `${p.id}|${p.url}|${p.token}`).join(",");

  const peerConnections = useMemo(
    () =>
      connectPeers
        ? peers.map((p) => createConnection(p.id, p.url.replace(/\/$/, ""), () => p.token))
        : [],
    // Rebuilt only when the set of peers actually changes.
    [peerKey, connectPeers],
  );
  useEffect(() => () => peerConnections.forEach((c) => c.live.close()), [peerConnections]);

  const value = useMemo<Servers>(() => {
    const all = [local, ...peerConnections];
    return { local, all, peers, byId: (id) => all.find((c) => c.id === id) };
  }, [local, peerConnections, peerKey]);

  return (
    <ServersContext.Provider value={value}>
      {value.all.map((c) => (
        <LiveBridge key={c.id} connection={c} />
      ))}
      {children}
    </ServersContext.Provider>
  );
}

/** Feeds one server's live socket into the query cache. Renders nothing. */
function LiveBridge({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  useEffect(() => {
    const off = connection.live.subscribe((m) => applyLive(qc, connection.id, m));
    const offReconnect = connection.live.onReconnect(() => void catchUp(qc, connection));
    return () => {
      off();
      offReconnect();
    };
  }, [qc, connection]);
  return null;
}

export function applyLive(qc: QueryClient, server: string, m: LiveMessage): void {
  switch (m.type) {
    case "nibblet":
      qc.setQueryData<Nibblet[]>(keys.nibblets(server), (old) => {
        if (!old) return old;
        const i = old.findIndex((n) => n.id === m.nibblet.id);
        if (i < 0) return [...old, m.nibblet];
        const next = [...old];
        next[i] = m.nibblet;
        return next;
      });
      return;
    case "nibblet_deleted":
      qc.setQueryData<Nibblet[]>(keys.nibblets(server), (old) => old?.filter((n) => n.id !== m.id));
      qc.removeQueries({ queryKey: keys.thread(server, m.id) });
      return;
    case "item":
      qc.setQueryData<StoredItem[]>(keys.thread(server, m.item.nibbletId), (old) =>
        old ? upsertItems(old, [m.item]) : old,
      );
      return;
    case "schedules_changed":
      void qc.invalidateQueries({ queryKey: keys.schedules(server, m.nibbletId) });
      return;
  }
}

/** After a reconnect: refetch the list, and pull each open thread forward from its cursor. */
async function catchUp(qc: QueryClient, connection: ServerConnection): Promise<void> {
  void qc.invalidateQueries({ queryKey: keys.nibblets(connection.id) });
  const threads = qc.getQueriesData<StoredItem[]>({ queryKey: ["thread", connection.id] });
  await Promise.all(
    threads.map(async ([key, items]) => {
      const id = key[2];
      if (typeof id !== "string" || !items) return;
      const fresh = await connection.client.thread.items({
        nibbletId: id,
        sinceSeq: maxSeq(items),
      });
      qc.setQueryData<StoredItem[]>(key, (old) => upsertItems(old ?? [], fresh));
    }),
  );
}

export function useLiveState(connection: ServerConnection): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  useEffect(() => connection.live.onState(setState), [connection]);
  return state;
}

export function useNibblets(connection: ServerConnection) {
  return useQuery({
    queryKey: keys.nibblets(connection.id),
    queryFn: () => connection.client.nibblets.list({}),
  });
}

export function useThread(connection: ServerConnection, id: string) {
  return useQuery({
    queryKey: keys.thread(connection.id, id),
    queryFn: async () =>
      upsertItems([], await connection.client.thread.items({ nibbletId: id, sinceSeq: 0 })),
    staleTime: Infinity,
  });
}
