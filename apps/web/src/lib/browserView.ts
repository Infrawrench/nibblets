import { z } from "zod";
import { safeJson, type ServerConnection } from "./connection.ts";

/*
 * OpenComputerUse's view protocol (0.7+), as served inside each nibblet's
 * container, twice: the browser (`computer`, the guard's) and the desktop
 * with the other apps (`desktop`, the agent's). The nibblet server proxies
 * `/api/nibblets/:id/{computer,desktop}/*` (HTTP and WebSocket) to them and
 * adds their tokens; HTTP here carries the usual Bearer header and
 * WebSockets take `?ticket=`.
 *
 *   GET    {kind}/sessions                       → { sessions: [Session] }
 *   POST   {kind}/sessions {app, args, display}  → 201 Session
 *   DELETE {kind}/sessions/{id}                  → { ok }
 *   WS     {kind}/sessions/{id}/view
 *          server → client  text:   hello | windows | error | ended
 *          server → client  binary: 20-byte little-endian header, then a JPEG or PNG
 *          client → server  text:   ViewInput
 */

/** Which of the container's OpenComputerUse servers. */
export type ComputerKind = "computer" | "desktop";

export const paths = {
  sessions: (kind: ComputerKind) => `${kind}/sessions`,
  session: (kind: ComputerKind, sessionId: string) =>
    `${kind}/sessions/${encodeURIComponent(sessionId)}`,
  view: (kind: ComputerKind, sessionId: string) =>
    `${kind}/sessions/${encodeURIComponent(sessionId)}/view`,
};

/** A wrapper in the runner image that adds the flags Chromium needs in a container. */
export const BROWSER_APP = "chromium";

export const OcuWindow = z.looseObject({
  id: z.number(),
  title: z.string(),
  frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  on_screen: z.boolean(),
});
export type OcuWindow = z.infer<typeof OcuWindow>;

export const OcuSession = z.looseObject({
  session_id: z.string(),
  session: z.looseObject({ id: z.string(), app: z.string() }),
  windows: z.array(OcuWindow),
});
export type OcuSession = z.infer<typeof OcuSession>;

export const ViewServerMessage = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("hello"),
    windows: z.array(OcuWindow),
    window: z.number().nullable(),
  }),
  z.looseObject({
    type: z.literal("windows"),
    windows: z.array(OcuWindow),
    window: z.number().nullable(),
  }),
  z.looseObject({ type: z.literal("error"), message: z.string() }),
  z.looseObject({ type: z.literal("ended") }),
]);
export type ViewServerMessage = z.infer<typeof ViewServerMessage>;

/** `MouseEvent.button`: 0 left, 1 middle, 2 right. */
export type PointerButton = 0 | 1 | 2;

export type ViewInput =
  | { type: "pointer"; action: "move" | "down" | "up"; x: number; y: number; button: PointerButton }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; action: "down" | "up"; code: string; key: string }
  | { type: "text"; text: string }
  | { type: "resize"; width: number; height: number }
  | { type: "window"; id: number }
  | { type: "refresh" };

/** One picture: either the whole window (a keyframe) or a patch to draw over it. */
export interface ViewFrame {
  bitmap: ImageBitmap;
  windowId: number;
  x: number;
  y: number;
  windowWidth: number;
  windowHeight: number;
  keyframe: boolean;
}

const HEADER_BYTES = 20;

/** Splits a binary view message into its header fields and the encoded image. */
export function parseFrameHeader(
  data: ArrayBuffer,
): (Omit<ViewFrame, "bitmap"> & { mime: string; image: ArrayBuffer }) | null {
  if (data.byteLength < HEADER_BYTES) return null;
  const v = new DataView(data);
  if (v.getUint8(0) !== 1) return null;
  const format = v.getUint8(1);
  return {
    mime: format === 2 ? "image/png" : "image/jpeg",
    keyframe: (v.getUint16(2, true) & 1) === 1,
    windowId: v.getUint32(4, true),
    x: v.getUint16(8, true),
    y: v.getUint16(10, true),
    windowWidth: v.getUint16(16, true),
    windowHeight: v.getUint16(18, true),
    image: data.slice(HEADER_BYTES),
  };
}

function nibbletPath(nibbletId: string, path: string): string {
  return `/api/nibblets/${encodeURIComponent(nibbletId)}/${path}`;
}

async function failure(res: Response, what: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `${res.status}`;
  return new Error(`${what} (${detail})`);
}

export async function listSessions(
  conn: ServerConnection,
  nibbletId: string,
  kind: ComputerKind = "computer",
): Promise<OcuSession[]> {
  const res = await conn.request(nibbletPath(nibbletId, paths.sessions(kind)));
  if (!res.ok) {
    throw await failure(
      res,
      kind === "computer" ? "Couldn't list browser sessions" : "Couldn't list apps",
    );
  }
  return z.object({ sessions: z.array(OcuSession) }).parse(await res.json()).sessions;
}

export async function openBrowser(conn: ServerConnection, nibbletId: string): Promise<OcuSession> {
  const res = await conn.request(nibbletPath(nibbletId, paths.sessions("computer")), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: BROWSER_APP, display: "wayland" }),
  });
  if (!res.ok) throw await failure(res, "Couldn't open the browser");
  return OcuSession.parse(await res.json());
}

/** Opens a desktop app on the nibblet's desktop, where it and the nibblet both see it. */
export async function launchApp(
  conn: ServerConnection,
  nibbletId: string,
  app: { name: string; command: string; args: string[] },
): Promise<OcuSession> {
  const res = await conn.request(nibbletPath(nibbletId, paths.sessions("desktop")), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: app.command, args: app.args, display: "wayland" }),
  });
  if (!res.ok) throw await failure(res, `Couldn't open ${app.name}`);
  return OcuSession.parse(await res.json());
}

/** Closes a session: the app, and every window it has open. */
export async function endSession(
  conn: ServerConnection,
  nibbletId: string,
  kind: ComputerKind,
  sessionId: string,
): Promise<void> {
  const res = await conn.request(nibbletPath(nibbletId, paths.session(kind, sessionId)), {
    method: "DELETE",
  });
  if (!res.ok) throw await failure(res, "Couldn't close it");
}

export type ViewState = "connecting" | "open" | "closed" | "ended" | "error";

/** A live view of one OCU session, the browser's or an app's. Images are decoded off the main thread. */
export class BrowserView {
  private socket: WebSocket | null = null;
  private closed = false;
  private readonly frameListeners = new Set<(frame: ViewFrame) => void>();
  private readonly messageListeners = new Set<(m: ViewServerMessage) => void>();
  private readonly stateListeners = new Set<(s: ViewState) => void>();

  constructor(url: Promise<string>) {
    void url.then(
      (u) => this.connect(u),
      () => this.setState("error"),
    );
  }

  onFrame(l: (frame: ViewFrame) => void): () => void {
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
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let ended = false;
    socket.onopen = () => this.setState("open");
    socket.onerror = () => this.setState("error");
    socket.onclose = () => this.setState(ended ? "ended" : "closed");
    // Patches must land in order, so decoding is chained rather than raced.
    let decoding: Promise<void> = Promise.resolve();
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        const parsed = ViewServerMessage.safeParse(safeJson(event.data));
        if (!parsed.success) return;
        if (parsed.data.type === "ended") ended = true;
        this.messageListeners.forEach((l) => l(parsed.data));
        return;
      }
      const frame = parseFrameHeader(event.data);
      if (!frame) return;
      const { image, mime, ...rest } = frame;
      decoding = decoding
        .then(() => createImageBitmap(new Blob([image], { type: mime })))
        .then((bitmap) => this.frameListeners.forEach((l) => l({ ...rest, bitmap })))
        .catch(() => {});
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
  kind: ComputerKind = "computer",
): Promise<string> {
  return conn.socketUrl(nibbletPath(nibbletId, paths.view(kind, sessionId)));
}

export function pointerButton(button: number): PointerButton {
  return button === 1 || button === 2 ? button : 0;
}

/** Wheel deltas in pixels, whatever unit the browser reported them in. */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }) {
  const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  return { dx: Math.round(e.deltaX * scale), dy: Math.round(e.deltaY * scale) };
}
