import { z } from "zod";
import {
  LiveMessage,
  contract,
  createClient,
  fetchTransport,
  type Client,
  type Contract,
  type Transport,
} from "@nibblet/protocol";

/**
 * One nibblet server the UI talks to: the one that served this page
 * (`local`), or one reached through Nibblets Connect. Each has its own typed
 * client and its own live socket.
 */
export interface ServerConnection {
  id: string;
  /** Empty for the server that served this page; otherwise its current origin. */
  base(): string;
  client: Client<Contract>;
  live: LiveFeed;
  /** A WebSocket URL with a fresh ticket, for any of this server's sockets. */
  socketUrl(path: string): Promise<string>;
  /** An authenticated HTTP request to a path on this server, outside the RPC contract. */
  request(path: string, init?: RequestInit): Promise<Response>;
  mock: boolean;
}

export type LiveState = "connecting" | "open" | "closed";

export interface LiveFeed {
  subscribe(listener: (message: LiveMessage) => void): () => void;
  onState(listener: (state: LiveState) => void): () => void;
  /** Called after every reconnect, so caches can catch up on what they missed. */
  onReconnect(listener: () => void): () => void;
  close(): void;
}

const TicketResponse = z.object({ ticket: z.string() });

/**
 * `base` is asked for on every call, so a connection can move to a better
 * route; `token` may be a short-lived one fetched just in time.
 */
export function createConnection(
  id: string,
  base: () => string,
  token: () => string | null | Promise<string | null>,
): ServerConnection {
  const headers = async (): Promise<Record<string, string>> => {
    const t = await token();
    return t ? { authorization: `Bearer ${t}` } : {};
  };
  const client = createClient(
    contract,
    fetchTransport(() => `${base()}/api/rpc`, headers),
  );

  const socketUrl = async (path: string): Promise<string> => {
    const res = await fetch(`${base()}/api/ticket`, { method: "POST", headers: await headers() });
    if (!res.ok) throw new Error(`Ticket refused (${res.status})`);
    const { ticket } = TicketResponse.parse(await res.json());
    const origin = base() || window.location.origin;
    const url = new URL(path, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    return url.toString();
  };

  const request = async (path: string, init: RequestInit = {}) =>
    fetch(`${base()}${path}`, {
      ...init,
      headers: { ...(await headers()), ...Object.fromEntries(new Headers(init.headers)) },
    });

  return {
    id,
    base,
    client,
    live: socketFeed(() => socketUrl("/api/live")),
    socketUrl,
    request,
    mock: false,
  };
}

/** A self-reconnecting feed of `LiveMessage`s over a WebSocket. */
function socketFeed(url: () => Promise<string>): LiveFeed {
  const listeners = new Set<(m: LiveMessage) => void>();
  const stateListeners = new Set<(s: LiveState) => void>();
  const reconnectListeners = new Set<() => void>();
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let everOpened = false;

  const setState = (s: LiveState) => stateListeners.forEach((l) => l(s));

  const connect = async () => {
    if (closed) return;
    setState("connecting");
    try {
      socket = new WebSocket(await url());
    } catch {
      retry();
      return;
    }
    socket.onopen = () => {
      attempt = 0;
      setState("open");
      if (everOpened) reconnectListeners.forEach((l) => l());
      everOpened = true;
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const parsed = LiveMessage.safeParse(safeJson(event.data));
      if (parsed.success) listeners.forEach((l) => l(parsed.data));
    };
    socket.onclose = () => {
      setState("closed");
      retry();
    };
  };

  const retry = () => {
    if (closed) return;
    attempt++;
    setTimeout(() => void connect(), Math.min(15_000, 500 * 2 ** attempt));
  };

  void connect();

  return {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onState(l) {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    onReconnect(l) {
      reconnectListeners.add(l);
      return () => reconnectListeners.delete(l);
    },
    close() {
      closed = true;
      socket?.close();
    },
  };
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A connection backed by in-process handlers, for `?mock`. */
export function createMockConnection(transport: Transport, live: LiveFeed): ServerConnection {
  return {
    id: "local",
    base: () => "",
    client: createClient(contract, transport),
    live,
    socketUrl: async () => "mock://",
    request: async () =>
      new Response(JSON.stringify({ sessions: [] }), {
        headers: { "content-type": "application/json" },
      }),
    mock: true,
  };
}
