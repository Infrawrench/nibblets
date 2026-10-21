import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { LiveMessage, Nibblet, StoredItem } from "@nibblet/protocol";
import {
  chooseRoute,
  localServerId,
  TokenCache,
  type CentralApi,
  type ChosenRoute,
} from "./central.ts";
import { createConnection, type LiveState, type ServerConnection } from "./connection.ts";
import { maxSeq, upsertItems } from "./thread.ts";

/** Query keys, in one place so the live bridge and the hooks agree. */
export const keys = {
  info: (server: string) => ["info", server] as const,
  nibblets: (server: string) => ["nibblets", server] as const,
  thread: (server: string, id: string) => ["thread", server, id] as const,
  schedules: (server: string, id: string) => ["schedules", server, id] as const,
  snapshots: (server: string, id: string) => ["snapshots", server, id] as const,
  tasks: (server: string, id: string) => ["tasks", server, id] as const,
  apps: (server: string, id: string) => ["apps", server, id] as const,
  spend: (server: string, id: string) => ["spend", server, id] as const,
  bank: (server: string) => ["bank", server] as const,
  cards: (server: string, id: string) => ["cards", server, id] as const,
  allowances: (server: string, id: string) => ["allowances", server, id] as const,
  memories: (server: string, id: string | null, query: string) =>
    ["memories", server, id, query] as const,
  hostTools: (server: string) => ["hostTools", server] as const,
  clis: (server: string) => ["clis", server] as const,
  connect: (server: string) => ["connect", server] as const,
  tailscale: (server: string) => ["tailscale", server] as const,
  publicAddress: (server: string) => ["publicAddress", server] as const,
  tailnetKeys: (server: string) => ["tailnetKeys", server] as const,
  harnessUpdates: (server: string) => ["harnessUpdates", server] as const,
  appUpdate: (server: string) => ["appUpdate", server] as const,
  machines: (server: string) => ["machines", server] as const,
  centralServers: () => ["central", "servers"] as const,
  route: (server: string, routes: string) => ["central", "route", server, routes] as const,
};

/** A machine running a nibblet server, whether or not it can be reached right now. */
export interface System {
  id: string;
  name: string;
  platform: string | null;
  online: boolean;
  /** Running on this computer. */
  local: boolean;
  /** How it's being reached, in central mode. */
  route: ChosenRoute | null;
  connection: ServerConnection | null;
}

/** Signed in to Nibblets Connect: the central-mode extras. */
export interface CentralSession {
  api: CentralApi;
  user: { id: string; name: string };
  refresh(): void;
}

interface Servers {
  systems: System[];
  /** Every system that can be reached. */
  all: ServerConnection[];
  byId(id: string): ServerConnection | undefined;
  system(id: string): System | undefined;
  central: CentralSession | null;
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
  systems,
  central = null,
  children,
}: {
  systems: System[];
  central?: CentralSession | null;
  children: ReactNode;
}) {
  const value = useMemo<Servers>(() => {
    const all = systems.flatMap((s) => (s.connection ? [s.connection] : []));
    return {
      systems,
      all,
      byId: (id) => all.find((c) => c.id === id),
      system: (id) => systems.find((s) => s.id === id),
      central,
    };
  }, [systems, central]);

  return (
    <ServersContext.Provider value={value}>
      {value.all.map((c) => (
        <LiveBridge key={c.id} connection={c} />
      ))}
      {children}
    </ServersContext.Provider>
  );
}

/** Local mode: just the server that served this page. */
export function LocalServers({
  connection,
  children,
}: {
  connection: ServerConnection;
  children: ReactNode;
}) {
  const info = useQuery({
    queryKey: keys.info(connection.id),
    queryFn: () => connection.client.system.info({}),
    staleTime: 60_000,
  });
  const name = info.data?.name ?? "This server";
  const systems = useMemo<System[]>(
    () => [
      {
        id: connection.id,
        name,
        platform: null,
        online: true,
        local: true,
        route: null,
        connection,
      },
    ],
    [connection, name],
  );
  return <ServersProvider systems={systems}>{children}</ServersProvider>;
}

/**
 * Central mode: every server on the account, each reached directly over the
 * best route that answers, with tokens from the central service.
 */
export function CentralServers({ api, children }: { api: CentralApi; children: ReactNode }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: keys.centralServers(),
    queryFn: () => api.servers(),
    refetchInterval: 15_000,
  });
  // This computer's own server first, then the rest as the account lists them.
  const localId = useMemo(() => localServerId(), []);
  const servers = useMemo(
    () =>
      [...(list.data?.servers ?? [])].sort(
        (a, b) => Number(b.id === localId) - Number(a.id === localId),
      ),
    [list.data, localId],
  );
  const tokens = useMemo(() => new TokenCache(api), [api]);
  const routes = useQueries({
    queries: servers.map((s) => ({
      queryKey: keys.route(s.id, JSON.stringify(s.routes)),
      queryFn: () => chooseRoute(s.routes, undefined, s.id === localId),
      // Re-probe now and then, so a closer route is picked up when it appears.
      refetchInterval: 30_000,
      staleTime: 25_000,
    })),
  });

  // One connection per server for as long as it's listed; its base follows the route.
  const bases = useRef(new Map<string, string>());
  // Historical routes are reconnect destinations, not evidence of reachability.
  const lastRoutes = useRef(new Map<string, ChosenRoute>());
  const connections = useRef(new Map<string, ServerConnection>());
  const subscriptions = useRef(new Map<string, () => void>());
  const [liveStates, setLiveStates] = useState(new Map<string, LiveState>());
  const systems = servers.map((s, i): System => {
    const probe = routes[i];
    const currentRoute = probe?.status === "success" ? probe.data : null;
    if (currentRoute) {
      bases.current.set(s.id, currentRoute.url);
      lastRoutes.current.set(s.id, currentRoute);
    }
    const route = currentRoute ?? lastRoutes.current.get(s.id) ?? null;
    let connection = connections.current.get(s.id) ?? null;
    if (route && !connection) {
      connection = createConnection(
        s.id,
        () => bases.current.get(s.id) ?? route.url,
        () => tokens.get(s.id),
      );
      connections.current.set(s.id, connection);
    }
    const online = currentRoute != null || liveStates.get(s.id) === "open";
    return {
      id: s.id,
      name: s.name,
      platform: s.platform,
      online,
      local: s.id === localId,
      route,
      connection: online ? connection : null,
    };
  });

  useEffect(() => {
    const listed = new Set(servers.map((s) => s.id));
    for (const [id, connection] of connections.current) {
      if (!listed.has(id)) {
        subscriptions.current.get(id)?.();
        subscriptions.current.delete(id);
        connection.live.close();
        connections.current.delete(id);
        lastRoutes.current.delete(id);
        bases.current.delete(id);
        setLiveStates((old) => {
          const next = new Map(old);
          next.delete(id);
          return next;
        });
      } else if (!subscriptions.current.has(id)) {
        subscriptions.current.set(
          id,
          connection.live.onState((state) => {
            setLiveStates((old) => {
              if (old.get(id) === state) return old;
              return new Map(old).set(id, state);
            });
          }),
        );
      }
    }
  });

  useEffect(
    () => () => {
      for (const off of subscriptions.current.values()) off();
      subscriptions.current.clear();
      for (const c of connections.current.values()) c.live.close();
      connections.current.clear();
    },
    [],
  );

  const central = useMemo<CentralSession | null>(
    () =>
      list.data
        ? {
            api,
            user: list.data.user,
            refresh: () => void qc.invalidateQueries({ queryKey: keys.centralServers() }),
          }
        : null,
    [api, list.data, qc],
  );

  return (
    <ServersProvider systems={systems} central={central}>
      {children}
    </ServersProvider>
  );
}

/** Feeds one server's live socket into the query cache. Renders nothing. */
function LiveBridge({ connection }: { connection: ServerConnection }) {
  const qc = useQueryClient();
  useEffect(() => {
    const off = connection.live.subscribe((m) => applyLive(qc, connection.id, m));
    const offReconnect = connection.live.onReconnect(() => void catchUp(qc, connection));
    void catchUp(qc, connection);
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
    case "tasks":
      qc.setQueryData(keys.tasks(server, m.nibbletId), m.tasks);
      return;
    case "apps":
      qc.setQueryData(keys.apps(server, m.nibbletId), m.apps);
      return;
    case "thread_reset":
      // A restore replaced the thread: what's cached can't be patched, only fetched again.
      void qc.resetQueries({ queryKey: keys.thread(server, m.nibbletId) });
      return;
    case "snapshots_changed":
      void qc.invalidateQueries({ queryKey: keys.snapshots(server, m.nibbletId) });
      return;
    case "cards_changed":
      void qc.invalidateQueries({ queryKey: keys.cards(server, m.nibbletId) });
      void qc.invalidateQueries({ queryKey: keys.allowances(server, m.nibbletId) });
      return;
    case "bank_changed":
      void qc.invalidateQueries({ queryKey: keys.bank(server) });
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
