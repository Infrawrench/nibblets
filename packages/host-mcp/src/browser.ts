import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { PipeBrowser } from "./cdp.ts";
import {
  LINUX_BASIC_KEYS,
  databaseVersions,
  hostKeyFlag,
  hostProfileKeys,
  outgrown,
  transcodeProfile,
} from "./profile-crypt.ts";

/**
 * Borrowing a nibblet's browser profile onto this computer for a quick
 * sign-in. The server stops the nibblet and streams its profile here; we
 * open it in a Chrome window, and when that window closes we purge every
 * extension (1Password included) and stream the profile back. The nibblet
 * never sees the host's 1Password or any other extension.
 */

/** A Chrome-family browser: where it's installed, and where its own profiles live. */
interface KnownBrowser {
  name: string;
  bin: string;
  /** Its default user-data folder, relative to the home folder. */
  data: string;
}

/** The Chrome/Chromium-family browsers we can open a borrowed profile in. */
const MAC_BROWSERS: KnownBrowser[] = [
  {
    name: "Google Chrome",
    bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    data: "Library/Application Support/Google/Chrome",
  },
  {
    name: "Chromium",
    bin: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    data: "Library/Application Support/Chromium",
  },
  {
    name: "Microsoft Edge",
    bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    data: "Library/Application Support/Microsoft Edge",
  },
  {
    name: "Brave",
    bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    data: "Library/Application Support/BraveSoftware/Brave-Browser",
  },
];
const LINUX_BROWSERS: KnownBrowser[] = [
  { name: "Google Chrome", bin: "/usr/bin/google-chrome", data: ".config/google-chrome" },
  { name: "Chromium", bin: "/usr/bin/chromium", data: ".config/chromium" },
  { name: "Chromium", bin: "/usr/bin/chromium-browser", data: ".config/chromium" },
  { name: "Microsoft Edge", bin: "/usr/bin/microsoft-edge", data: ".config/microsoft-edge" },
  { name: "Brave", bin: "/usr/bin/brave-browser", data: ".config/BraveSoftware/Brave-Browser" },
];
const knownBrowsers = () => (process.platform === "darwin" ? MAC_BROWSERS : LINUX_BROWSERS);

/** 1Password's browser extension IDs, newest first (v8, then classic). */
const ONEPASSWORD_EXTENSIONS = [
  "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  "dppgmdbiimibapkepcbdbmkaabgiofem",
];
/** 1Password's native-messaging manifests, which let its extension talk to the app. */
const ONEPASSWORD_HOSTS = /^com\.1password\..*\.json$/;
/** Google Chrome ignores `--load-extension` from this version on. */
const CHROME_DROPPED_LOAD_EXTENSION = 137;

/** Profile subfolders that hold extensions or their state; all removed before handback. */
const EXTENSION_DIRS = [
  "Extensions",
  "Local Extension Settings",
  "Sync Extension Settings",
  "Managed Extension Settings",
  "Extension State",
  "Extension Rules",
  "Extension Scripts",
  join("Storage", "ext"),
  "NativeMessagingHosts",
];
/** Per-origin storage folders, where an extension's are named `chrome-extension_<id>_…`. */
const ORIGIN_DIRS = ["IndexedDB", "databases", "File System"];
const EXTENSION_ID = /^[a-p]{32}$/;

const isDir = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

export interface HostBrowser {
  name: string;
  bin: string;
  data: string;
  /** Its major version, or null if it wouldn't say. */
  major: number | null;
  /** Whether it honours `--load-extension`, which adding 1Password needs. */
  loadsExtensions: boolean;
}

function browserMajor(bin: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      const major = err ? undefined : /(\d+)\.\d+\.\d+/.exec(stdout)?.[1];
      resolve(major ? Number(major) : null);
    });
  });
}

/** The Chrome-family browsers installed on this computer, in order of preference. */
export async function installedBrowsers(): Promise<HostBrowser[]> {
  const found: HostBrowser[] = [];
  for (const known of knownBrowsers()) {
    if (!(await isFile(known.bin))) continue;
    const major = await browserMajor(known.bin);
    const loadsExtensions =
      known.name !== "Google Chrome" || (major !== null && major < CHROME_DROPPED_LOAD_EXTENSION);
    found.push({ ...known, data: join(homedir(), known.data), major, loadsExtensions });
  }
  return found;
}

/** The browser to open a borrowed profile in: one that can add 1Password, if that's wanted. */
export function chooseBrowser(browsers: HostBrowser[], withExtension: boolean): HostBrowser | null {
  return (
    (withExtension ? browsers.find((b) => b.loadsExtensions) : undefined) ?? browsers[0] ?? null
  );
}

/**
 * An unpacked copy of the host's 1Password extension, if it's installed in
 * any browser's default profile — the newest version's folder, which
 * `--load-extension` can point at. Null if 1Password isn't there.
 */
export async function onePasswordExtensionDir(): Promise<string | null> {
  for (const known of knownBrowsers()) {
    const base = join(homedir(), known.data, "Default", "Extensions");
    for (const id of ONEPASSWORD_EXTENSIONS) {
      const dir = join(base, id);
      const versions = await readdir(dir).catch(() => [] as string[]);
      // Folders are named by version (e.g. "8.10.2_0").
      const newest = versions
        .filter((v) => !v.startsWith("."))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const pick = newest.at(-1);
      if (pick && (await isFile(join(dir, pick, "manifest.json")))) return join(dir, pick);
    }
  }
  return null;
}

/** What `GET /browser` answers: whether a profile can be opened here, and with 1Password. */
export async function hostBrowserStatus(): Promise<{ chrome: boolean; onePassword: boolean }> {
  const extension = await onePasswordExtensionDir();
  const browser = chooseBrowser(await installedBrowsers(), extension !== null);
  return { chrome: browser !== null, onePassword: Boolean(extension && browser?.loadsExtensions) };
}

export interface BorrowOptions {
  /** A gzipped tar rooted at `chromium/`, from the server. */
  profileTar: Readable;
  /** Where the handed-back profile (same shape) is written when the window closes. */
  out: Writable;
  userAgent: string | null;
  /** A proxy for the window, e.g. `http://127.0.0.1:54321`. */
  proxy: string | null;
  /** Add the host's 1Password to the window, if it's installed. */
  wantOnePassword: boolean;
  /** Aborting kills the window and skips the handback (the server won't restore). */
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/**
 * Opens a borrowed profile in a Chrome window and resolves once it closes,
 * having written the cleaned profile to `out`. Throws if there's no browser
 * to open it in, if the borrow was aborted, or if the profile can't be
 * handed back in a shape the nibblet's Chromium reads.
 */
export async function borrowProfile(opts: BorrowOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const extension = opts.wantOnePassword ? await onePasswordExtensionDir() : null;
  const browser = chooseBrowser(await installedBrowsers(), extension !== null);
  if (!browser) throw new Error("No Chrome, Chromium, Edge or Brave is installed on this computer");

  const tmp = await mkdtemp(join(tmpdir(), "nibblet-borrow-"));
  const profile = join(tmp, "chromium");
  try {
    await extractTar(opts.profileTar, tmp);
    await mkdir(profile, { recursive: true });
    await stripProfileLocks(profile);
    // What the nibblet's Chromium last wrote, to check it can still read them after.
    const before = await databaseVersions(profile);
    const ownExtensions = await extensionIds(profile);
    await transcodeProfile(profile, LINUX_BASIC_KEYS, hostProfileKeys());

    const common = [
      `--user-data-dir=${profile}`,
      hostKeyFlag(),
      "--no-first-run",
      "--no-default-browser-check",
      "--no-service-autorun",
    ];
    if (opts.proxy) common.push(`--proxy-server=${opts.proxy}`);
    const args = [...common, "--disable-features=InfiniteSessionRestore"];
    if (opts.userAgent) args.push(`--user-agent=${opts.userAgent}`);
    if (extension && browser.loadsExtensions) {
      args.push(`--load-extension=${extension}`, `--disable-extensions-except=${extension}`);
      await addOnePasswordHosts(profile);
      log(`Added 1Password to the borrowed ${browser.name} window`);
    }
    args.push("about:blank");

    await runWindow(browser.bin, args, opts.signal);
    log("The borrowed window closed; purging extensions and handing it back");

    const added = await extensionIds(profile);
    await clearExtensionStorage(browser.bin, common, [
      ...ownExtensions,
      ...added,
      ...ONEPASSWORD_EXTENSIONS,
    ]);
    await purgeProfileExtensions(profile);
    const upgraded = outgrown(profile, before, await databaseVersions(profile));
    if (upgraded.length > 0) {
      throw new Error(
        `${browser.name}${browser.major ? ` ${browser.major}` : ""} upgraded ${upgraded.join(", ")} ` +
          "past what the nibblet's Chromium can open, so the sign-in can't be handed back. " +
          "Updating Nibblets brings a newer Chromium.",
      );
    }
    await transcodeProfile(profile, hostProfileKeys(), LINUX_BASIC_KEYS);
    await stripProfileLocks(profile);
    await packTar(profile, tmp, opts.out);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface TargetInfo {
  targetId: string;
  type: string;
}

/**
 * Runs the window and resolves when it's closed; an abort terminates it and
 * rejects. On a Mac, closing the last window leaves the browser running, so
 * it's asked to quit once it has no pages left. Exported to be tried against a real browser.
 */
export async function runWindow(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("borrow aborted");
  const browser = new PipeBrowser(bin, args);
  const onAbort = () => browser.child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  let failed: Error | null = null;
  browser.child.once("error", (err) => (failed = err));
  const pages = new Set<string>();
  browser.on("Target.targetCreated", (params) => {
    const { targetInfo } = params as { targetInfo: TargetInfo };
    if (targetInfo.type === "page") pages.add(targetInfo.targetId);
  });
  browser.on("Target.targetDestroyed", (params) => {
    const { targetId } = params as { targetId: string };
    if (pages.delete(targetId) && pages.size === 0) void browser.close();
  });
  await browser.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
  await browser.exited;
  signal?.removeEventListener("abort", onAbort);
  if (failed) throw failed;
  if (signal?.aborted) throw new Error("borrow aborted");
}

/**
 * Clears what each extension kept in the browser's own storage (IndexedDB,
 * local storage, service workers, caches, file systems), which lives in
 * stores shared with websites and can't be picked out by folder. Done in a
 * headless run of the same browser after the window has closed. Exported, as `runWindow` is.
 */
export async function clearExtensionStorage(
  bin: string,
  common: string[],
  ids: string[],
): Promise<void> {
  const browser = new PipeBrowser(bin, [...common, "--headless=new", "--disable-extensions"]);
  const timer = setTimeout(() => browser.child.kill("SIGKILL"), 60_000);
  try {
    const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    for (const id of new Set(ids)) {
      await browser.send(
        "Storage.clearDataForOrigin",
        { origin: `chrome-extension://${id}`, storageTypes: "all" },
        sessionId,
      );
    }
  } catch (err) {
    throw new Error(
      `Couldn't clear the extensions' storage: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await browser.close();
    clearTimeout(timer);
  }
}

/** The browser profiles in a user-data folder (Default, Profile 1, …), and the folder itself. */
async function profileDirs(profile: string): Promise<string[]> {
  const entries = await readdir(profile).catch(() => [] as string[]);
  return [profile, ...entries.map((e) => join(profile, e))];
}

/** The ids of every extension the profile has installed or keeps state for. */
export async function extensionIds(profile: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const base of await profileDirs(profile)) {
    for (const dir of ["Extensions", "Local Extension Settings", "Sync Extension Settings"]) {
      for (const id of await readdir(join(base, dir)).catch(() => [] as string[])) ids.add(id);
    }
    for (const prefs of ["Preferences", "Secure Preferences"]) {
      const parsed = await readFile(join(base, prefs), "utf8")
        .then((text) => JSON.parse(text) as { extensions?: { settings?: object } })
        .catch(() => null);
      for (const id of Object.keys(parsed?.extensions?.settings ?? {})) ids.add(id);
    }
  }
  return [...ids].filter((id) => EXTENSION_ID.test(id));
}

/**
 * With a profile of its own, the browser looks for native-messaging hosts in
 * that profile rather than its usual folder, so 1Password's are copied in
 * (and purged with the rest before handback).
 */
async function addOnePasswordHosts(profile: string): Promise<void> {
  const into = join(profile, "NativeMessagingHosts");
  await mkdir(into, { recursive: true });
  for (const known of knownBrowsers()) {
    const from = join(homedir(), known.data, "NativeMessagingHosts");
    for (const name of await readdir(from).catch(() => [] as string[])) {
      if (ONEPASSWORD_HOSTS.test(name))
        await copyFile(join(from, name), join(into, name)).catch(() => undefined);
    }
  }
}

/**
 * Removes every extension and its state from each of the profile's
 * directories, so nothing (1Password included) is handed back to the
 * nibblet. What extensions keep in the browser's shared stores is cleared
 * before this, by `clearExtensionStorage`. Exported so the purge can be
 * tested on its own.
 */
export async function purgeProfileExtensions(profile: string): Promise<void> {
  if (!(await isDir(profile))) return;
  // Each browser profile (Default, Profile 1, System Profile, …) keeps its own.
  for (const base of await profileDirs(profile)) {
    for (const ext of EXTENSION_DIRS) {
      await rm(join(base, ext), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const dir of ORIGIN_DIRS) {
      for (const entry of await readdir(join(base, dir)).catch(() => [] as string[])) {
        if (entry.startsWith("chrome-extension_"))
          await rm(join(base, dir, entry), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    for (const prefs of ["Preferences", "Secure Preferences"]) {
      await stripExtensionsFromPrefs(join(base, prefs)).catch(() => undefined);
    }
  }
}

/** Drops the `extensions` block from a Chrome preferences file, if it has one. */
async function stripExtensionsFromPrefs(path: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || !("extensions" in parsed)) return;
  delete parsed.extensions;
  await writeFile(path, JSON.stringify(parsed));
}

/** Clears the single-instance locks so Chrome opens the copied profile. */
async function stripProfileLocks(profile: string): Promise<void> {
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(profile, lock), { force: true }).catch(() => undefined);
  }
}

function extractTar(input: Readable, into: string): Promise<void> {
  return pipeThroughTar(["-C", into, "-xzf", "-"], { stdin: input });
}

function packTar(profileDir: string, cwd: string, out: Writable): Promise<void> {
  return pipeThroughTar(["-C", cwd, "-czf", "-", "chromium"], { stdout: out, profileDir });
}

/** Runs system `tar`, piping a stream in or out. */
function pipeThroughTar(
  args: string[],
  io: { stdin?: Readable; stdout?: Writable; profileDir?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, {
      stdio: [io.stdin ? "pipe" : "ignore", io.stdout ? "pipe" : "ignore", "pipe"],
    });
    const errChunks: Buffer[] = [];
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    if (io.stdin && child.stdin) io.stdin.pipe(child.stdin);
    // The handed-back tar ends `out` only once tar has finished cleanly (below),
    // so a failed pack never reaches the server as a complete profile.
    if (io.stdout && child.stdout) child.stdout.pipe(io.stdout, { end: false });
    child.on("close", (code) => {
      if (code === 0) {
        if (io.stdout) io.stdout.end(() => resolve());
        else resolve();
      } else
        reject(
          new Error(`tar exited ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}`),
        );
    });
  });
}
