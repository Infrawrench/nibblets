import { z } from "zod";
import {
  FileRef,
  LiveMessage,
  contract,
  createClient,
  fetchTransport,
  type Client,
  type Contract,
  type Transport,
} from "@nibblet/protocol";
import { mockFileUrl, registerMockFile } from "./files.ts";

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
  pinClient(guard: () => void): Client<Contract>;
  live: LiveFeed;
  /** A WebSocket URL with a fresh ticket, for any of this server's sockets. */
  socketUrl(path: string): Promise<string>;
  /** An authenticated HTTP request to a path on this server, outside the RPC contract. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Uploads a file to a nibblet, reporting progress from 0 to 1. */
  upload(nibbletId: string, file: File, onProgress: (fraction: number) => void): Promise<FileRef>;
  /** A link an <img> or <a> can use for a stored file, signed so it needs no header. */
  fileUrl(fileId: string): Promise<string>;
  mock: boolean;
}

export type LiveState = "connecting" | "open" | "closed";

export class RouteChangedError extends Error {}

export interface LiveFeed {
  subscribe(listener: (message: LiveMessage) => void): () => void;
  /** Calls `listener` with the current state straight away, then on every change. */
  onState(listener: (state: LiveState) => void): () => void;
  /** Called after every reconnect, so caches can catch up on what they missed. */
  onReconnect(listener: () => void): () => void;
  close(): void;
}

export function refetchOnLiveOpen(live: LiveFeed, refetch: () => void): () => void {
  return live.onState((state) => {
    if (state === "open") refetch();
  });
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

  // XMLHttpRequest rather than fetch: it's the one that reports upload progress.
  const upload = async (nibbletId: string, file: File, onProgress: (f: number) => void) => {
    const auth = await headers();
    const url = `${base()}/api/nibblets/${encodeURIComponent(nibbletId)}/files?name=${encodeURIComponent(file.name)}`;
    return new Promise<FileRef>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new Error("The upload didn't reach the server"));
      xhr.onload = () => {
        const body = safeJson(xhr.responseText);
        const ref = FileRef.safeParse(body);
        if (xhr.status < 300 && ref.success) resolve(ref.data);
        else
          reject(
            new Error(UploadError.safeParse(body).data?.error ?? `Upload failed (${xhr.status})`),
          );
      };
      xhr.send(file);
    });
  };

  const fileUrl = async (fileId: string) => {
    const res = await request(`/api/files/${encodeURIComponent(fileId)}/link`, { method: "POST" });
    const link = FileLink.parse(await res.json());
    return `${base() || window.location.origin}${link.url}`;
  };

  return {
    id,
    base,
    client,
    pinClient: (guard) => {
      const pinned = base();
      return createClient(
        contract,
        fetchTransport(`${pinned}/api/rpc`, headers, () => {
          if (base() !== pinned)
            throw new RouteChangedError(
              "Host route changed during verification. Queued sending paused.",
            );
          guard();
        }),
      );
    },
    live: socketFeed(() => socketUrl("/api/live")),
    socketUrl,
    request,
    upload,
    fileUrl,
    mock: false,
  };
}

const FileLink = z.object({ url: z.string() });
const UploadError = z.object({ error: z.string() });

/** The server says something at least this often, if only a keepalive. */
const SILENT_FOR_MS = 75_000;
/** A drop is only reported as "closed" once reconnecting has failed this many times. */
const QUIET_RETRIES = 3;

/**
 * A self-reconnecting feed of `LiveMessage`s over a WebSocket. Drops are
 * normal (proxies close idle sockets, laptops sleep), so it reconnects
 * straight away and only reports "closed" when that keeps failing. A socket
 * that goes silent past the server's keepalive is treated as dead.
 */
export function socketFeed(url: () => Promise<string>): LiveFeed {
  const listeners = new Set<(m: LiveMessage) => void>();
  const stateListeners = new Set<(s: LiveState) => void>();
  const reconnectListeners = new Set<() => void>();
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let everOpened = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let state: LiveState = "connecting";

  const setState = (s: LiveState) => {
    state = s;
    stateListeners.forEach((l) => l(s));
  };

  const heardFrom = (ws: WebSocket) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => ws.close(), SILENT_FOR_MS);
  };

  const connect = async () => {
    if (closed) return;
    if (attempt === 0) setState("connecting");
    else if (attempt > QUIET_RETRIES) setState("closed");
    let ws: WebSocket;
    try {
      ws = new WebSocket(await url());
    } catch {
      retry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      heardFrom(ws);
      setState("open");
      if (everOpened) reconnectListeners.forEach((l) => l());
      everOpened = true;
    };
    ws.onmessage = (event) => {
      heardFrom(ws);
      if (typeof event.data !== "string") return;
      const parsed = LiveMessage.safeParse(safeJson(event.data));
      if (parsed.success) listeners.forEach((l) => l(parsed.data));
    };
    ws.onclose = () => {
      if (watchdog) clearTimeout(watchdog);
      if (socket !== ws) return;
      socket = null;
      // Stay "open" through the first few quick retries; the UI needn't flicker.
      if (state !== "open" || attempt >= QUIET_RETRIES) setState("closed");
      retry();
    };
  };

  const retry = () => {
    if (closed) return;
    attempt++;
    // The first retry is immediate: most drops are an idle socket being tidied away.
    setTimeout(() => void connect(), attempt === 1 ? 0 : Math.min(15_000, 500 * 2 ** attempt));
  };

  void connect();

  return {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onState(l) {
      stateListeners.add(l);
      // Told where things stand now: a socket to this computer can open
      // before anything starts listening, and would never be heard of again.
      l(state);
      return () => stateListeners.delete(l);
    },
    onReconnect(l) {
      reconnectListeners.add(l);
      return () => reconnectListeners.delete(l);
    },
    close() {
      closed = true;
      if (watchdog) clearTimeout(watchdog);
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
    pinClient: (guard) =>
      createClient(contract, (path, input) => {
        guard();
        return transport(path, input);
      }),
    live,
    socketUrl: async () => "mock://",
    request: async () =>
      new Response(JSON.stringify({ sessions: [] }), {
        headers: { "content-type": "application/json" },
      }),
    upload: async (_nibbletId, file, onProgress) => {
      // Pretend to upload, so the progress UI can be judged in mock mode.
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 60));
        onProgress(i / 10);
      }
      return registerMockFile(file, file.name, file.type || "application/octet-stream");
    },
    fileUrl: async (fileId) => mockFileUrl(fileId),
    mock: true,
  };
}
