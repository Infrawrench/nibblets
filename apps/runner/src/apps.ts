/**
 * The desktop apps installed in the container, for the launcher the user
 * and the agent share: what's there, from the XDG desktop entries, and
 * starting one on the desktop (the agent's own OpenComputerUse; see
 * desktop.ts), where both of them can see and use it.
 *
 * The user's list comes up the runner's socket (`apps`); the agent's comes
 * from the `apps` MCP server here. Both start apps through the desktop's
 * view server, so a session either of them opens is the other's too.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerSpec } from "@nibblet/harness";
import type { DesktopApp } from "@nibblet/protocol";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/** Icons bigger than this are left out, so a list of them stays small enough to send. */
const MAX_ICON_BYTES = 48 * 1024;
/** Icon sizes to look in, best first: the launcher draws them at 40 pixels. */
const ICON_SIZES = [
  "48x48",
  "64x64",
  "scalable",
  "96x96",
  "128x128",
  "32x32",
  "256x256",
  "512x512",
];
const ICON_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** The XDG data folders, most important first: the user's own, then the system's. */
export function dataDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const own = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const system = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [...new Set([own, ...system])];
}

/** Undoes a desktop entry value's escapes (`\s`, `\n`, `\t`, `\r`, `\\`). */
function unescapeValue(raw: string): string {
  return raw.replace(/\\([sntr\\])/g, (_, c: string) =>
    c === "s" ? " " : c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : "\\",
  );
}

/** The keys of a desktop entry's `[Desktop Entry]` group, unlocalised. */
export function entryKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  let inGroup = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      // Only the first group counts; actions come after it.
      if (inGroup) break;
      inGroup = trimmed === "[Desktop Entry]";
      continue;
    }
    if (!inGroup) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!keys.has(key)) keys.set(key, trimmed.slice(eq + 1).trim());
  }
  return keys;
}

/**
 * An `Exec` line as argv, without its field codes (`%f`, `%U` and the like,
 * which stand for files and URLs the launcher would pass). Arguments are
 * split on spaces, and double quotes group them, with `\"`, `` \` ``, `\$`
 * and `\\` escaped inside.
 */
export function execArgv(exec: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!;
    if (quoted) {
      if (c === "\\" && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1]!)) {
        current += exec[++i];
      } else if (c === '"') {
        quoted = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === " " || c === "\t") {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) argv.push(current);
  return argv
    .filter((a) => !/^%[fFuUdDnNickvm]$/.test(a))
    .map((a) => a.replace(/%([fFuUdDnNickvm%])/g, (_, c: string) => (c === "%" ? "%" : "")));
}

const isTrue = (v: string | undefined) => v === "true" || v === "1";

/** Whether `name` (a path or a command on PATH) can be run. */
async function runnable(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = name.includes("/")
    ? [name]
    : (env.PATH ?? "").split(":").map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Not this one.
    }
  }
  return false;
}

/**
 * Whether an app belongs in the launcher. The browser has its own panel, and
 * the agent its own (the guard's) Chromium with its logins, so a second
 * Chromium here would only confuse things.
 */
function shown(command: string): boolean {
  return !path.basename(command).startsWith("chromium");
}

/** One desktop entry as an app, or null when it isn't one to offer. */
export async function readEntry(
  id: string,
  text: string,
  icon: (name: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopApp | null> {
  const keys = entryKeys(text);
  if (keys.get("Type") !== "Application") return null;
  // Settings panels and the like that only one desktop shows, and entries
  // that need a terminal: the user has a terminal of their own.
  if (isTrue(keys.get("NoDisplay")) || isTrue(keys.get("Hidden"))) return null;
  if (isTrue(keys.get("Terminal")) || keys.has("OnlyShowIn")) return null;
  const name = keys.get("Name");
  const exec = keys.get("Exec");
  if (!name || !exec) return null;
  const tryExec = keys.get("TryExec");
  if (tryExec && !(await runnable(unescapeValue(tryExec), env))) return null;
  const [command, ...args] = execArgv(unescapeValue(exec));
  if (!command || !shown(command)) return null;
  const comment = keys.get("Comment") ?? keys.get("GenericName");
  const iconName = keys.get("Icon");
  return {
    id,
    name: unescapeValue(name),
    comment: comment ? unescapeValue(comment) : null,
    icon: iconName ? await icon(unescapeValue(iconName)) : null,
    command,
    args,
    categories: (keys.get("Categories") ?? "").split(";").filter(Boolean),
  };
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** Desktop entry files under `dir`, with their ids (`kde/foo.desktop` is `kde-foo`). */
async function entryFiles(dir: string, prefix = ""): Promise<{ id: string; file: string }[]> {
  const out: { id: string; file: string }[] = [];
  for (const name of (await listDir(dir)).sort()) {
    const file = path.join(dir, name);
    if (name.endsWith(".desktop")) {
      out.push({ id: `${prefix}${name.slice(0, -".desktop".length)}`, file });
    } else if (!name.includes(".") && (await stat(file).catch(() => null))?.isDirectory()) {
      out.push(...(await entryFiles(file, `${prefix}${name}-`)));
    }
  }
  return out;
}

async function dataUrl(file: string): Promise<string | null> {
  const type = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size > MAX_ICON_BYTES) return null;
  const bytes = await readFile(file).catch(() => null);
  return bytes ? `data:${type};base64,${bytes.toString("base64")}` : null;
}

/**
 * Finds an icon by its theme name, the way a desktop would, near enough:
 * hicolor (where apps put theirs) and the other installed themes, at the
 * sizes in ICON_SIZES, then the old pixmaps folder. An absolute path is
 * read as it is.
 */
export function iconFinder(dirs: readonly string[], home = homedir()) {
  const roots = [path.join(home, ".icons"), ...dirs.map((d) => path.join(d, "icons"))];
  const pixmaps = dirs.map((d) => path.join(d, "pixmaps"));
  const cache = new Map<string, Promise<string | null>>();
  const find = async (name: string): Promise<string | null> => {
    if (path.isAbsolute(name)) return dataUrl(name);
    if (name.includes("/")) return null;
    const names =
      path.extname(name) in ICON_TYPES ? [name] : Object.keys(ICON_TYPES).map((e) => name + e);
    for (const root of roots) {
      const themes = (await listDir(root)).sort((a, b) =>
        a === "hicolor" ? -1 : b === "hicolor" ? 1 : a.localeCompare(b),
      );
      for (const theme of themes) {
        for (const size of ICON_SIZES) {
          for (const file of names) {
            const found = await dataUrl(path.join(root, theme, size, "apps", file));
            if (found) return found;
          }
        }
      }
    }
    for (const dir of pixmaps) {
      for (const file of names) {
        const found = await dataUrl(path.join(dir, file));
        if (found) return found;
      }
    }
    return null;
  };
  return (name: string) => {
    let found = cache.get(name);
    if (!found) cache.set(name, (found = find(name)));
    return found;
  };
}

/**
 * Every app installed in the container, by name. An entry in an earlier
 * folder hides one with the same id in a later one, even when it hides it
 * on purpose (`Hidden=true`), as the spec says.
 */
export async function scanApps(
  dirs: readonly string[] = dataDirs(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopApp[]> {
  const icon = iconFinder(dirs);
  const seen = new Set<string>();
  const apps: DesktopApp[] = [];
  for (const dir of dirs) {
    for (const { id, file } of await entryFiles(path.join(dir, "applications"))) {
      if (seen.has(id)) continue;
      seen.add(id);
      const text = await readFile(file, "utf8").catch(() => null);
      const app = text === null ? null : await readEntry(id, text, icon, env);
      if (app) apps.push(app);
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the desktop's view server says about a session it started. */
const Started = z.looseObject({
  session_id: z.string(),
  windows: z.array(z.looseObject({ id: z.number(), title: z.string() })).default([]),
});

export interface DesktopAppsOptions {
  /** The desktop's view server, like `http://127.0.0.1:7901`, and its token. */
  viewUrl: string;
  token: string;
  /** Called with the list whenever a scan finds it changed. */
  onChange?: (apps: DesktopApp[]) => void;
  /** Overrides how the list is made, for tests. */
  scan?: () => Promise<DesktopApp[]>;
}

/** The launcher: the apps there are, and opening one on the desktop. */
export class DesktopApps {
  private readonly opts: DesktopAppsOptions;
  private last: DesktopApp[] = [];
  private lastJson = "[]";
  private http: HttpServer | null = null;

  constructor(opts: DesktopAppsOptions) {
    this.opts = opts;
  }

  /** Looks again, tells `onChange` if anything changed, and returns the list. */
  async scan(): Promise<DesktopApp[]> {
    const apps = await (this.opts.scan ?? scanApps)();
    const json = JSON.stringify(apps);
    if (json !== this.lastJson) {
      this.last = apps;
      this.lastJson = json;
      this.opts.onChange?.(apps);
    }
    return apps;
  }

  list(): DesktopApp[] {
    return this.last;
  }

  /** Opens an app on the desktop; `files` go after its own arguments. */
  async launch(id: string, files: readonly string[] = []) {
    const app = (await this.scan()).find((a) => a.id === id);
    if (!app) throw new Error(`No app ${id}. app_list says which there are.`);
    const res = await fetch(`${this.opts.viewUrl}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ app: app.command, args: [...app.args, ...files], display: "wayland" }),
      signal: AbortSignal.timeout(60_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body ? String(body.error) : res.statusText;
      throw new Error(`Couldn't open ${app.name}: ${message}`);
    }
    return { app, ...Started.parse(body) };
  }

  async startMcp(): Promise<McpServerSpec> {
    const reply = async (work: () => Promise<string>) => {
      try {
        return { content: [{ type: "text" as const, text: await work() }] };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    };
    const http = createServer((req, res) => {
      const server = new McpServer({ name: "apps", version: "0.1.0" });
      server.registerTool(
        "app_list",
        {
          description:
            "List the desktop apps installed in your container, which you and the user both open on your desktop and both see. Each line gives the id app_launch takes.",
          inputSchema: {},
        },
        () =>
          reply(async () => {
            const apps = await this.scan();
            if (apps.length === 0) return "No desktop apps are installed.";
            return apps
              .map((a) => `- ${a.name} (${a.id})${a.comment ? `: ${a.comment}` : ""}`)
              .join("\n");
          }),
      );
      server.registerTool(
        "app_launch",
        {
          description:
            "Open a desktop app from app_list on your desktop, and get its session id for the `desktop` tools (screenshot, click, type_text and the rest). The user sees it in their Apps panel straight away, and can watch and use it alongside you.",
          inputSchema: {
            id: z.string().describe("The app's id, from app_list"),
            files: z
              .array(z.string())
              .optional()
              .describe("Files or URLs to open it with, as it would take them on its command line"),
          },
        },
        ({ id, files }) =>
          reply(async () => {
            const { app, session_id, windows } = await this.launch(id, files);
            const titles = windows.map((w) => `"${w.title}" (window ${w.id})`).join(", ");
            return `Opened ${app.name} as session ${session_id}${titles ? `, showing ${titles}` : ""}.`;
          }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    this.http = http;
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", () => done()));
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} };
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => (this.http ? this.http.close(() => done()) : done()));
  }
}
