import { z } from "zod";
import { safeJson, type ServerConnection } from "./connection.ts";

/*
 * ─── OpenComputerUse view protocol ──────────────────────────────────────────
 *
 * Everything that depends on OCU's view server lives in this file. The
 * nibblet server proxies `/api/nibblets/:id/computer/*` (HTTP and WebSocket)
 * to OCU inside the nibblet's container and adds OCU's own auth. HTTP here
 * uses the usual Bearer header; WebSockets take `?ticket=`.
 *
 * PROVISIONAL: OCU's paths and messages aren't final. When the spec lands,
 * fix up `paths`, the schemas, and `ViewInput` below; nothing else in the UI
 * needs to change.
 *
 *   GET  computer/sessions                     → sessions (array, or { sessions })
 *   POST computer/sessions {app, display}      → the started session
 *   WS   computer/sessions/{id}/view
 *        server → client  binary: one encoded image (JPEG or PNG) of the window
 *        server → client  text:   JSON `ViewServerMessage`
 *        client → server  text:   JSON `ViewInput`
 * ────────────────────────────────────────────────────────────────────────────
 */

export const paths = {
  sessions: "computer/sessions",
  view: (sessionId: string) => `computer/sessions/${encodeURIComponent(sessionId)}/view`,
};

export const BROWSER_APP = "chromium";

export const OcuSession = z.looseObject({
  id: z.string(),
  app: z.string().optional(),
  display: z.string().optional(),
});
export type OcuSession = z.infer<typeof OcuSession>;

const SessionList = z.union([
  z.array(OcuSession),
  z.looseObject({ sessions: z.array(OcuSession) }),
]);
const StartedSession = z.union([OcuSession, z.looseObject({ session: OcuSession })]);

export const ViewServerMessage = z.union([
  z.looseObject({
    type: z.literal("window"),
    width: z.number(),
    height: z.number(),
    title: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("closed") }),
  z.looseObject({ type: z.string() }),
]);
export type ViewServerMessage = z.infer<typeof ViewServerMessage>;

export type PointerButton = "left" | "middle" | "right";

export type ViewInput =
  | { type: "pointer"; action: "move" | "down" | "up"; x: number; y: number; button: PointerButton }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; action: "down" | "up"; code: string; key: string }
  | { type: "text"; text: string }
  | { type: "resize"; width: number; height: number };

function nibbletPath(nibbletId: string, path: string): string {
  return `/api/nibblets/${encodeURIComponent(nibbletId)}/${path}`;
}

export async function listSessions(
  conn: ServerConnection,
  nibbletId: string,
): Promise<OcuSession[]> {
  const res = await conn.request(nibbletPath(nibbletId, paths.sessions));
  if (!res.ok) throw new Error(`Couldn't list browser sessions (${res.status})`);
  const parsed = SessionList.parse(await res.json());
  return Array.isArray(parsed) ? parsed : parsed.sessions;
}

export async function openBrowser(conn: ServerConnection, nibbletId: string): Promise<OcuSession> {
  const res = await conn.request(nibbletPath(nibbletId, paths.sessions), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: BROWSER_APP, display: "wayland" }),
  });
  if (!res.ok) throw new Error(`Couldn't open the browser (${res.status})`);
  const parsed = StartedSession.parse(await res.json());
  return "session" in parsed && typeof parsed.session === "object"
    ? OcuSession.parse(parsed.session)
    : OcuSession.parse(parsed);
}

export type ViewState = "connecting" | "open" | "closed" | "error";

/**
 * A live view of one OCU session window. Frames arrive as encoded images
 * and are decoded off the main thread with createImageBitmap.
 */
export class BrowserView {
  private socket: WebSocket | null = null;
  private closed = false;
  private readonly frameListeners = new Set<(frame: ImageBitmap) => void>();
  private readonly messageListeners = new Set<(m: ViewServerMessage) => void>();
  private readonly stateListeners = new Set<(s: ViewState) => void>();

  constructor(url: Promise<string>) {
    void url.then(
      (u) => this.connect(u),
      () => this.setState("error"),
    );
  }

  onFrame(l: (frame: ImageBitmap) => void): () => void {
    this.frameListeners.add(l);
    return () => this.frameListeners.delete(l);
  }

  onMessage(l: (m: ViewServerMessage) => void): () => void {
    this.messageListeners.add(l);
    return () => this.messageListeners.delete(l);
  }

  onState(l: (s: ViewState) => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  send(input: ViewInput): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(input));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  private connect(url: string): void {
    if (this.closed) return;
    this.setState("connecting");
    const socket = new WebSocket(url);
    socket.binaryType = "blob";
    this.socket = socket;
    socket.onopen = () => this.setState("open");
    socket.onerror = () => this.setState("error");
    socket.onclose = () => this.setState("closed");
    socket.onmessage = (event) => {
      if (event.data instanceof Blob) {
        void createImageBitmap(event.data).then(
          (bitmap) => this.frameListeners.forEach((l) => l(bitmap)),
          () => {},
        );
        return;
      }
      if (typeof event.data === "string") {
        const parsed = ViewServerMessage.safeParse(safeJson(event.data));
        if (parsed.success) this.messageListeners.forEach((l) => l(parsed.data));
      }
    };
  }

  private setState(s: ViewState): void {
    this.stateListeners.forEach((l) => l(s));
  }
}

export function viewUrl(
  conn: ServerConnection,
  nibbletId: string,
  sessionId: string,
): Promise<string> {
  return conn.socketUrl(nibbletPath(nibbletId, paths.view(sessionId)));
}

const BUTTONS: Record<number, PointerButton> = { 0: "left", 1: "middle", 2: "right" };

export function pointerButton(button: number): PointerButton {
  return BUTTONS[button] ?? "left";
}
