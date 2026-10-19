// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CentralServers, keys, useServers } from "./servers.tsx";
import type { CentralApi, ServerList } from "./central.ts";
import type { LiveMessage } from "@nibblet/protocol";
import type { LiveState } from "./connection.ts";

const boundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./connection.ts", () => ({ createConnection: boundary.create }));
let root: Root;
let qc: QueryClient;
let health: boolean;
let state: LiveState;
let seen: ReturnType<typeof useServers>;
let emit: (next: LiveState) => void;
let emitMessage: (message: LiveMessage) => void;
let close: ReturnType<typeof vi.fn>;
let items: ReturnType<typeof vi.fn>;
let base: () => string;
let list: ServerList;
const routeKey = () => keys.route("remote", JSON.stringify(list.servers[0]?.routes));

function Read() {
  seen = useServers();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  health = true;
  state = "closed";
  close = vi.fn();
  items = vi.fn(async () => []);
  const listeners = new Set<(next: LiveState) => void>();
  emit = (next) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  boundary.create.mockReset().mockImplementation((id: string, getBase: () => string) => {
    base = getBase;
    return {
      id,
      base: getBase,
      client: { thread: { items } },
      live: {
        subscribe: (listener: (message: LiveMessage) => void) => {
          emitMessage = listener;
          return () => {};
        },
        onReconnect: vi.fn(() => () => {}),
        onState: (listener: (next: LiveState) => void) => {
          listeners.add(listener);
          listener(state);
          return () => listeners.delete(listener);
        },
        close,
      },
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: health ? 200 : 503 })),
  );
  list = {
    user: { id: "user", name: "Test" },
    servers: [
      {
        id: "remote",
        name: "Remote",
        hostname: "remote",
        platform: "linux",
        version: null,
        nibblets: 0,
        online: false,
        lastSeenAt: null,
        linkedAt: "2026-01-01T00:00:00.000Z",
        routes: { lan: [], tailscale: null, tunnel: "https://remote.example" },
      },
    ],
  };
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.centralServers(), list);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  qc.clear();
  vi.unstubAllGlobals();
});

async function mount() {
  const api = { servers: async () => list } as CentralApi;
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CentralServers, { api, children: createElement(Read) }),
      ),
    ),
  );
  await settle();
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function probe() {
  await act(async () => {
    await qc.refetchQueries({ queryKey: routeKey(), exact: true });
  });
  await settle();
}

it("probes a remote server with a stale heartbeat and exposes the answering route", async () => {
  await mount();
  expect(fetch).toHaveBeenCalledWith("https://remote.example/healthz", expect.anything());
  expect(seen.system("remote")?.online).toBe(true);
  expect(seen.byId("remote")).toBeDefined();
});

it("uses latest probe and live state, never historical route alone, and recovers without reload", async () => {
  list.servers[0]!.online = true;
  await mount();
  const original = seen.byId("remote");
  health = false;
  await probe();
  expect(seen.system("remote")?.route?.url).toBe("https://remote.example");
  expect(seen.system("remote")?.online).toBe(false);
  expect(seen.byId("remote")).toBeUndefined();
  qc.setQueryData(keys.thread("remote", "thread"), []);
  await act(async () => emit("open"));
  expect(seen.system("remote")?.online).toBe(true);
  expect(seen.byId("remote")).toBe(original);
  expect(items).toHaveBeenCalledWith({ nibbletId: "thread", sinceSeq: 0 });
  qc.setQueryData(keys.snapshots("remote", "thread"), []);
  emitMessage({ type: "snapshots_changed", nibbletId: "thread", activity: "restoring" });
  expect(qc.getQueryState(keys.snapshots("remote", "thread"))?.isInvalidated).toBe(true);
  await act(async () => emit("closed"));
  expect(seen.system("remote")?.online).toBe(false);
  expect(boundary.create).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});

it("keeps a live route usable across heartbeat loss and updates the retained connection base", async () => {
  list.servers[0]!.online = true;
  await mount();
  const original = seen.byId("remote");
  await act(async () => emit("open"));
  list = {
    ...list,
    servers: list.servers.map((s) => ({
      ...s,
      online: false,
      routes: { ...s.routes, tunnel: "https://replacement.example" },
    })),
  };
  await act(async () => {
    qc.setQueryData(keys.centralServers(), list);
  });
  await settle();
  expect(seen.system("remote")?.online).toBe(true);
  expect(seen.byId("remote")).toBe(original);
  expect(base()).toBe("https://replacement.example");
  expect(boundary.create).toHaveBeenCalledTimes(1);
});

it("closes removed servers and ignores subsequent live state changes", async () => {
  list.servers[0]!.online = true;
  await mount();
  await act(async () => {
    qc.setQueryData(keys.centralServers(), { ...list, servers: [] });
  });
  await settle();
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => emit("open"));
  expect(seen.systems).toEqual([]);
});
