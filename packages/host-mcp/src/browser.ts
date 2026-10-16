import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Borrowing a nibblet's browser profile onto this computer for a quick
 * sign-in. The server stops the nibblet and streams its profile here; we
 * open it in a Chrome window, and when that window closes we purge every
 * extension (1Password included) and stream the profile back. The nibblet
 * never sees the host's 1Password or any other extension.
 */

/** The Chrome/Chromium-family browsers we can open a borrowed profile in. */
const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX_BROWSERS = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** 1Password's browser extension IDs, newest first (v8, then classic). */
const ONEPASSWORD_EXTENSIONS = [
  "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  "dppgmdbiimibapkepcbdbmkaabgiofem",
];

/** Profile subfolders that hold extensions or their state; all removed before handback. */
const EXTENSION_DIRS = [
  "Extensions",
  "Local Extension Settings",
  "Extension State",
  "Extension Rules",
  "Managed Extension Settings",
  "Extension Scripts",
];

const exists = (path: string): Promise<boolean> =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  );

/** The first Chrome-family browser installed on this computer, or null. */
export async function detectHostChrome(): Promise<string | null> {
  for (const path of process.platform === "darwin" ? MAC_BROWSERS : LINUX_BROWSERS) {
    if (await exists(path)) return path;
  }
  return null;
}

/** The default Chrome profile's folder on this computer, where an installed extension lives. */
function chromeProfileDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Google", "Chrome", "Default");
  }
  return join(homedir(), ".config", "google-chrome", "Default");
}

/**
 * An unpacked copy of the host's 1Password extension, if it's installed in
 * the default Chrome profile — the newest version's folder, which
 * `--load-extension` can point at. Null if 1Password isn't there.
 */
export async function onePasswordExtensionDir(): Promise<string | null> {
  const base = join(chromeProfileDir(), "Extensions");
  for (const id of ONEPASSWORD_EXTENSIONS) {
    const dir = join(base, id);
    let versions: string[];
    try {
      versions = await readdir(dir);
    } catch {
      continue;
    }
    // Folders are named by version (e.g. "2.0.1_0"); the last one sorted is newest enough.
    const newest = versions.filter((v) => !v.startsWith(".")).sort();
    const pick = newest.at(-1);
    if (pick && (await exists(join(dir, pick, "manifest.json")))) return join(dir, pick);
  }
  return null;
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
 * to open it in, or if the borrow was aborted.
 */
export async function borrowProfile(opts: BorrowOptions): Promise<{ onePassword: boolean }> {
  const log = opts.log ?? (() => {});
  const chrome = await detectHostChrome();
  if (!chrome) throw new Error("No Chrome, Chromium, Edge or Brave is installed on this computer");

  const tmp = await mkdtemp(join(tmpdir(), "nibblet-borrow-"));
  const profile = join(tmp, "chromium");
  try {
    await extractTar(opts.profileTar, tmp);
    await stripProfileLocks(profile);

    const extension = opts.wantOnePassword ? await onePasswordExtensionDir() : null;
    const args = [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-service-autorun",
      "--disable-features=InfiniteSessionRestore",
    ];
    if (opts.userAgent) args.push(`--user-agent=${opts.userAgent}`);
    if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
    if (extension) {
      args.push(`--load-extension=${extension}`, `--disable-extensions-except=${extension}`);
      log("Added 1Password to the borrowed window");
    }
    args.push("about:blank");

    await runBrowser(chrome, args, opts.signal);
    log("The borrowed window closed; purging extensions and handing it back");

    await purgeProfileExtensions(profile);
    await packTar(profile, tmp, opts.out);
    return { onePassword: Boolean(extension) };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Runs the browser and resolves when it exits; an abort terminates it and rejects. */
function runBrowser(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("borrow aborted"));
    const child = spawn(bin, args, { stdio: "ignore" });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("exit", () => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("borrow aborted"));
      else resolve();
    });
  });
}

/**
 * Removes every extension and its state from each of the profile's
 * directories, so nothing (1Password included) is handed back to the
 * nibblet. Exported so the purge can be tested on its own.
 */
export async function purgeProfileExtensions(profile: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(profile);
  } catch {
    return;
  }
  // Each browser profile (Default, Profile 1, System Profile, …) keeps its own.
  const profiles = ["", ...entries];
  for (const dir of profiles) {
    const base = dir ? join(profile, dir) : profile;
    for (const ext of EXTENSION_DIRS) {
      await rm(join(base, ext), { recursive: true, force: true }).catch(() => undefined);
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
    if (io.stdout && child.stdout) child.stdout.pipe(io.stdout, { end: true });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`tar exited ${code}: ${Buffer.concat(errChunks).toString("utf8").trim()}`),
        );
    });
  });
}
