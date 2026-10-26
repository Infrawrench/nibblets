import { z } from "zod";
import { JsonValue } from "./schema.ts";

/**
 * MCP Apps: a tool that names a `ui://` resource in its `_meta.ui` has a
 * view, HTML the chat shows in a sandboxed frame with the call's input and
 * result. The guard's gate notices these calls, reads the view, and hands it
 * to the server, which keeps it apart from the thread since many calls share
 * one. See https://modelcontextprotocol.io/extensions/apps.
 */

/** What a view's resource is served as. Anything else isn't shown. */
export const APP_VIEW_MIME = "text/html;profile=mcp-app";

/** The most HTML one view may be. Bigger ones aren't shown. */
export const MAX_APP_VIEW_BYTES = 2 * 1024 * 1024;
/** The most a call's input and result, together as JSON, may be for its view to be shown. */
export const MAX_APP_VIEW_CALL_BYTES = 1024 * 1024;

/** Who may see or call a tool with a view: the agent, the view, or both (the default). */
export const AppToolVisibility = z.enum(["model", "app"]);
export type AppToolVisibility = z.infer<typeof AppToolVisibility>;

const Domains = z.array(z.string()).max(50).optional();

/** Where a view may load from and connect to, beyond its own HTML. */
export const AppViewCsp = z.object({
  connectDomains: Domains,
  resourceDomains: Domains,
  frameDomains: Domains,
  baseUriDomains: Domains,
});
export type AppViewCsp = z.infer<typeof AppViewCsp>;

/** What a view asks its frame to be allowed. Only the clipboard is ever given. */
export const AppViewPermissions = z.object({
  camera: z.object({}).optional(),
  microphone: z.object({}).optional(),
  geolocation: z.object({}).optional(),
  clipboardWrite: z.object({}).optional(),
});
export type AppViewPermissions = z.infer<typeof AppViewPermissions>;

/** A view as the server keeps it, and the web app fetches it (`nibblets.view`). */
export const AppViewContent = z.object({
  html: z.string(),
  csp: AppViewCsp,
  permissions: AppViewPermissions,
  /** Whether it wants the chat to draw a border around it. */
  prefersBorder: z.boolean().nullable(),
});
export type AppViewContent = z.infer<typeof AppViewContent>;

/** A call with a view, as the guard reports it at `/guard/:id/view`. */
export const GuardAppView = z.object({
  server: z.string(),
  tool: z.string(),
  input: JsonValue,
  /** The tool's result: MCP's `CallToolResult`, as JSON. */
  result: JsonValue,
  uri: z.string(),
  view: AppViewContent,
});
export type GuardAppView = z.infer<typeof GuardAppView>;

const UiMeta = z.object({
  resourceUri: z.string().optional(),
  visibility: z.array(AppToolVisibility).optional(),
});

/** A tool's `_meta`, as far as views go: the nested form, and the flat one it replaced. */
const ToolMeta = z.object({
  ui: UiMeta.optional(),
  "ui/resourceUri": z.string().optional(),
});

export interface ToolView {
  /** Its view's `ui://` address, or null for a tool without one. */
  uri: string | null;
  visibility: AppToolVisibility[];
}

/** What a tool's `_meta` says about its view: where it is, if anywhere, and who sees the tool. */
export function toolView(meta: object | undefined): ToolView {
  const parsed = ToolMeta.safeParse(meta ?? {});
  const ui = parsed.success ? parsed.data : {};
  const uri = ui.ui?.resourceUri ?? ui["ui/resourceUri"] ?? null;
  return {
    uri: uri?.startsWith("ui://") ? uri : null,
    visibility: ui.ui?.visibility?.length ? ui.ui.visibility : ["model", "app"],
  };
}

/** A view resource's own `_meta.ui`: what it may load, and how it's drawn. */
const ResourceMeta = z.object({
  ui: z
    .object({
      csp: AppViewCsp.optional().catch(undefined),
      permissions: AppViewPermissions.optional().catch(undefined),
      prefersBorder: z.boolean().optional().catch(undefined),
    })
    .optional(),
});

/**
 * A view from what `resources/read` gave for its `ui://` address: the first
 * content that's an MCP App's HTML, with its settings. Null when there's none.
 */
export function readAppView(contents: readonly object[]): AppViewContent | null {
  const Content = z.object({
    mimeType: z.literal(APP_VIEW_MIME),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: ResourceMeta.optional().catch(undefined),
  });
  for (const raw of contents) {
    const content = Content.safeParse(raw);
    if (!content.success) continue;
    const { text, blob, _meta } = content.data;
    const html = text ?? (blob === undefined ? null : decodeBase64(blob));
    if (html === null) continue;
    const ui = _meta?.ui;
    return {
      html,
      csp: ui?.csp ?? {},
      permissions: ui?.permissions ?? {},
      prefersBorder: ui?.prefersBorder ?? null,
    };
  }
  return null;
}

function decodeBase64(blob: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(blob), (c) => c.charCodeAt(0)));
}
