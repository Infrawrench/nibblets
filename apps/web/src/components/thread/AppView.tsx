import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Loader2 } from "lucide-react";
import {
  AppBridge,
  buildAllowAttribute,
  PostMessageTransport,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { JsonValue, type ThreadItemOf } from "@nibblets/protocol";
import { z } from "zod";
import type { ServerConnection } from "../../lib/connection.ts";
import {
  cleanCsp,
  grantedPermissions,
  MAX_VIEW_HEIGHT,
  viewHeight,
  withPolicy,
} from "../../lib/appViews.ts";
import { openWeb } from "../../lib/links.ts";
import { cn } from "../../lib/cn.ts";

/** Puts text in the message box for the person to send, or not. */
export type DraftFn = (text: string) => void;

/** Where a view's calls and HTML come from: its nibblet, on its server. */
export interface AppViewHost {
  connection: ServerConnection;
  nibbletId: string;
  onDraft?: DraftFn;
}

const scheme = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const theme = () => (scheme()?.matches ? "dark" : "light");

/**
 * A tool's MCP App view, live in the thread: its HTML in a sandboxed frame
 * with an origin of its own, given the call's input and result. It can call
 * tools on its own server (gated like the nibblet's calls), open web links,
 * and suggest a message, which goes in the box for the person to send.
 */
export function AppView({ item, host }: { item: ThreadItemOf<"app_view">; host: AppViewHost }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  // A long thread can have many: each starts once it's nearly on screen, then stays.
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver !== "function") return setSeen(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);

  return (
    <div ref={box} className="overflow-hidden rounded-lg border border-line bg-panel text-xs">
      <div className="flex h-7 items-center gap-2 px-2 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <span className="flex size-5 items-center justify-center rounded bg-deep text-dim">
          <AppWindow />
        </span>
        <span className="font-medium">{item.tool.replace(/_/g, " ")}</span>
        <span className="min-w-0 flex-1 truncate text-faint">
          {item.server.replace(/^host_/, "")}
        </span>
      </div>
      {seen ? <Frame item={item} host={host} /> : <div className="h-40 border-t border-line" />}
    </div>
  );
}

function Frame({ item, host }: { item: ThreadItemOf<"app_view">; host: AppViewHost }) {
  const { connection, nibbletId } = host;
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  // The latest callbacks, without restarting the view when they change.
  const latest = useRef(host);
  latest.current = host;
  const view = useQuery({
    queryKey: ["app-view", connection.id, nibbletId, item.viewId],
    queryFn: () => connection.client.nibblets.view({ id: nibbletId, viewId: item.viewId }),
    staleTime: Infinity,
  });
  const content = view.data;

  useEffect(() => {
    const el = frame.current;
    const win = el?.contentWindow;
    if (!content || !el || !win) return;
    const granted = grantedPermissions(content.permissions);
    const context = (): McpUiHostContext => ({
      theme: theme(),
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: {
        maxHeight: MAX_VIEW_HEIGHT,
        width: frame.current?.clientWidth ?? 0,
      },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: "Nibblets",
      platform: matchMedia("(pointer: coarse)").matches ? "mobile" : "web",
      deviceCapabilities: {
        touch: matchMedia("(pointer: coarse)").matches,
        hover: matchMedia("(hover: hover)").matches,
      },
    });
    const bridge = new AppBridge(
      null,
      { name: "Nibblets", version: "1.0.0" },
      {
        openLinks: {},
        serverTools: {},
        message: { text: {} },
        logging: {},
        sandbox: { csp: cleanCsp(content.csp), permissions: granted },
      },
      { hostContext: context() },
    );
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: toolArguments(item.input) });
      const result = CallToolResultSchema.safeParse(item.result);
      if (result.success) void bridge.sendToolResult(result.data);
    };
    bridge.onsizechange = ({ height }) => setHeight((h) => viewHeight(height, h));
    bridge.oncalltool = async ({ name, arguments: args }) => {
      const result = await connection.client.nibblets.viewCall({
        id: nibbletId,
        itemId: item.id,
        tool: name,
        arguments: Arguments.parse(args ?? {}),
      });
      return CallToolResultSchema.parse(result);
    };
    bridge.onopenlink = async ({ url }) => {
      openWeb(url);
      return {};
    };
    bridge.onmessage = async ({ content: blocks }) => {
      const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
      const draft = latest.current.onDraft;
      if (!draft || !text.trim()) return { isError: true };
      draft(text);
      return {};
    };
    bridge.onrequestdisplaymode = async () => ({ mode: "inline" });

    const media = scheme();
    const retheme = () => void bridge.sendHostContextChange({ theme: theme() });
    media?.addEventListener("change", retheme);
    // Listening before the view loads, so its first message isn't missed.
    void bridge.connect(new PostMessageTransport(win, win)).then(() => {
      el.srcdoc = withPolicy(content.html, content.csp);
    });
    return () => {
      media?.removeEventListener("change", retheme);
      void bridge
        .teardownResource({}, { timeout: 1000 })
        .catch(() => {})
        .finally(() => void bridge.close());
    };
  }, [content, connection, nibbletId, item.id, item.input, item.result]);

  if (view.isError) {
    return (
      <div className="border-t border-line px-2.5 py-2 text-faint">
        Couldn't load this view: {view.error.message}
      </div>
    );
  }
  if (!content) {
    return (
      <div className="flex h-40 items-center justify-center border-t border-line text-faint">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  return (
    <iframe
      ref={frame}
      title={`${item.tool} from ${item.server}`}
      // No allow-same-origin: the view gets an origin of its own, away from this page's.
      sandbox="allow-scripts allow-forms"
      allow={buildAllowAttribute(grantedPermissions(content.permissions))}
      style={{ height }}
      className={cn(
        "block w-full bg-surface",
        content.prefersBorder === false ? "" : "border-t border-line",
      )}
    />
  );
}

const Arguments = z.record(z.string(), JsonValue);

/** A call's arguments as an object, which is all a tool takes. */
function toolArguments(input: ThreadItemOf<"app_view">["input"]) {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
}
