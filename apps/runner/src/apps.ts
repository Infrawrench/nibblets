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
import type { McpServerSpec } from "@nibblets/harness";
import type { DesktopApp } from "@nibblets/protocol";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { serveMcp, toolReply } from "./mcp-http.ts";

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
 * An `Exec` line's words. Spaces separate them, and double quotes group
 * them, with `\"`, `` \` ``, `\$` and `\\` escaped inside. Field codes are
 * left in; execArgv fills them.
 */
export function execWords(exec: string): string[] {
  const words: string[] = [];
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
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/**
 * An `Exec` line as argv, its field codes filled in: `%F` and `%U` with all
 * of `files` (files or URLs), `%f` and `%u` with the first (a launcher would
 * start the app once for each; this starts it once), and the rest with
 * nothing. Files for an app whose line has no place for them go at the end.
 */
export function execArgv(exec: string, files: readonly string[] = []): string[] {
  const argv: string[] = [];
  let placed = false;
  for (const word of execWords(exec)) {
    if (word === "%F" || word === "%U") {
      argv.push(...files);
      placed = true;
    } else if (word === "%f" || word === "%u") {
      if (files[0] !== undefined) argv.push(files[0]);
      placed = true;
    } else if (/^%[dDnNickvm]$/.test(word)) {
      // Deprecated, or the icon and name, which nothing here needs.
    } else {
      argv.push(
        word.replace(/%([fFuUdDnNickvm%])/g, (_, c: string) => {
          if (c === "%") return "%";
          if (!"fFuU".includes(c)) return "";
          placed = true;
          return files[0] ?? "";
        }),
      );
    }
  }
  if (!placed) argv.push(...files);
  return argv;
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

/** An app as a scan finds it: with its `Exec` line, for starting it with files. */
export type ScannedApp = DesktopApp & { exec: string };

/** One desktop entry as an app, or null when it isn't one to offer. */
export async function readEntry(
  id: string,
  text: string,
  icon: (name: string) => Promise<string | null>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScannedApp | null> {
  const keys = entryKeys(text);
  if (keys.get("Type") !== "Application") return null;
  // Settings panels and the like that only one desktop shows, and entries
  // that need a terminal: the user has a terminal of their own.
  if (isTrue(keys.get("NoDisplay")) || isTrue(keys.get("Hidden"))) return null;
  if (isTrue(keys.get("Terminal")) || keys.has("OnlyShowIn")) return null;
  const name = keys.get("Name");
  const rawExec = keys.get("Exec");
  if (!name || !rawExec) return null;
  const tryExec = keys.get("TryExec");
  if (tryExec && !(await runnable(unescapeValue(tryExec), env))) return null;
  const exec = unescapeValue(rawExec);
  const [command, ...args] = execArgv(exec);
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
    exec,
  };
}

/** What goes to the user: everything but the `Exec` line. */
function forUser({ exec: _, ...app }: ScannedApp): DesktopApp {
  return app;
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

/** How long an icon that wasn't found stays not found, before it's looked for again. */
const ICON_MISS_MS = 60_000;

/**
 * Finds an icon by its theme name, the way a desktop would, near enough:
 * hicolor (where apps put theirs) and the other installed themes, at the
 * sizes in ICON_SIZES, then the old pixmaps folder. An absolute path is
 * read as it is. What it finds is kept, and what it doesn't is looked for
 * again after ICON_MISS_MS, since an app the agent adds may bring its icon
 * after its entry.
 */
export function iconFinder(dirs: readonly string[], home = homedir(), now = Date.now) {
  const roots = [path.join(home, ".icons"), ...dirs.map((d) => path.join(d, "icons"))];
  const pixmaps = dirs.map((d) => path.join(d, "pixmaps"));
  const cache = new Map<string, { found: Promise<string | null>; at: number }>();
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
  return async (name: string) => {
    const kept = cache.get(name);
    if (kept && ((await kept.found) !== null || now() - kept.at < ICON_MISS_MS)) {
      return kept.found;
    }
    const found = find(name);
    cache.set(name, { found, at: now() });
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
  icon: (name: string) => Promise<string | null> = iconFinder(dirs),
): Promise<ScannedApp[]> {
  const seen = new Set<string>();
  const apps: ScannedApp[] = [];
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
  scan?: () => Promise<ScannedApp[]>;
  /**
   * The display apps open on: Linux's headless Wayland one; none elsewhere,
   * where they open on the signed-in desktop. This platform's unless given.
   */
  display?: "wayland" | null;
}

/** The launcher: the apps there are, and opening one on the desktop. */
export class DesktopApps {
  private readonly opts: DesktopAppsOptions;
  private readonly scanner: () => Promise<ScannedApp[]>;
  private last: ScannedApp[] = [];
  private lastJson = "[]";
  /** Scans can overlap; only one newer than what's shown replaces it. */
  private started = 0;
  private shown = 0;
  private closeMcp: (() => Promise<void>) | null = null;

  constructor(opts: DesktopAppsOptions) {
    this.opts = opts;
    if (opts.scan) {
      this.scanner = opts.scan;
    } else {
      // Kept between scans: looking for icons is most of a scan's work.
      const dirs = dataDirs();
      const icon = iconFinder(dirs);
      this.scanner = () => scanApps(dirs, process.env, icon);
    }
  }

  /** Looks again, tells `onChange` if anything changed, and returns the list. */
  async scan(): Promise<DesktopApp[]> {
    const run = ++this.started;
    const apps = await this.scanner();
    if (run > this.shown) {
      this.shown = run;
      const json = JSON.stringify(apps);
      if (json !== this.lastJson) {
        this.last = apps;
        this.lastJson = json;
        this.opts.onChange?.(this.list());
      }
    }
    return this.list();
  }

  list(): DesktopApp[] {
    return this.last.map(forUser);
  }

  /** Opens an app on the desktop, with files (or URLs) where its `Exec` line takes them. */
  async launch(id: string, files: readonly string[] = []) {
    const find = () => this.last.find((a) => a.id === id);
    // Only an app the last scan didn't see is worth scanning again for.
    const app = find() ?? (await this.scan(), find());
    if (!app) throw new Error(`No app ${id}. app_list says which there are.`);
    const [command, ...args] = execArgv(app.exec, files);
    const display =
      this.opts.display === undefined
        ? process.platform === "linux"
          ? "wayland"
          : null
        : this.opts.display;
    const res = await fetch(`${this.opts.viewUrl}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ app: command, args, ...(display ? { display } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body ? String(body.error) : res.statusText;
      throw new Error(`Couldn't open ${app.name}: ${message}`);
    }
    return { app: forUser(app), ...Started.parse(body) };
  }

  async startMcp(): Promise<McpServerSpec> {
    const served = await serveMcp("apps", (server) => {
      server.registerTool(
        "app_list",
        {
          description:
            "List the desktop apps installed in your container, which you and the user both open on your desktop and both see. Each line gives the id app_launch takes.",
          inputSchema: {},
        },
        () =>
          toolReply(async () => {
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
              .describe(
                "Files or URLs to open it with. An app that takes one at a time gets the first.",
              ),
          },
        },
        ({ id, files }) =>
          toolReply(async () => {
            const { app, session_id, windows } = await this.launch(id, files);
            const titles = windows.map((w) => `"${w.title}" (window ${w.id})`).join(", ");
            return `Opened ${app.name} as session ${session_id}${titles ? `, showing ${titles}` : ""}.`;
          }),
      );
    });
    this.closeMcp = served.close;
    return served.spec;
  }

  async close(): Promise<void> {
    await this.closeMcp?.();
  }
}
