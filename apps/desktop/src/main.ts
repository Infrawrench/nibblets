import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { ConnectStatus } from "@nibblet/protocol";
import { z } from "zod";
import { ipcMain } from "electron/main";
import { startHostMcpBridge, type HostMcpBridge } from "@nibblet/host-mcp";
import { startKeychainBridge } from "./bridge.ts";
import { detectCredentials } from "./credentials.ts";
import { checkDocker } from "./docker.ts";
import type { SetupPage, SetupStep } from "./preload.ts";
import { HOST_MCP_PORT, IMAGE_PREFIX, Stack } from "./stack.ts";
import { SetupTerminal } from "./terminal.ts";
import { checkTools, findAction, forgetShellPath } from "./tools.ts";
import { AppUpdates } from "./updates.ts";
import { navigationAllowed, openOutside } from "./links.ts";
import { adoptShellPath } from "./shell-path.ts";
import { opencodePaths } from "@nibblet/host-mcp";

const SERVER_URL = "http://127.0.0.1:8420/";
const DEFAULT_CENTRAL_URL = "https://app.nibblets.dev/";

interface Settings {
  paired: boolean;
  stopOnQuit: boolean;
  /** Whether this computer runs a server, or only shows ones elsewhere. Null until asked. */
  runServer: boolean | null;
  centralUrl: string;
  /** The "connect this server to your account?" prompt has been shown. */
  offeredConnect: boolean;
  /** The "get this computer ready" page has been through once. */
  setupDone: boolean;
  /** A release the person chose not to be offered again. */
  skippedVersion: string | null;
}

const settingsPath = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Settings> {
  const defaults: Settings = {
    paired: false,
    stopOnQuit: false,
    runServer: null,
    centralUrl: DEFAULT_CENTRAL_URL,
    offeredConnect: false,
    setupDone: false,
    skippedVersion: null,
  };
  try {
    const parsed: Partial<Settings> = JSON.parse(await readFile(settingsPath(), "utf8"));
    // Installs from before the question was asked were already running a server.
    const runServer = parsed.runServer ?? (parsed.paired ? true : null);
    // Nor do they need walking through getting ready.
    const setupDone = parsed.setupDone ?? parsed.paired ?? false;
    return { ...defaults, ...parsed, runServer, setupDone };
  } catch {
    return defaults;
  }
}

const saveSettings = (s: Settings) => writeFile(settingsPath(), JSON.stringify(s, null, 2));

/** A packaged app that's still sitting in a checkout's build folder, for development. */
function localBuild(): boolean {
  return /[/\\]apps[/\\]desktop[/\\]dist[/\\]/.test(process.execPath);
}

/** In a checkout the repo is two levels above this app; packaged, the compose file is a resource. */
function stackPaths() {
  if (app.isPackaged) {
    return {
      dir: join(app.getPath("userData"), "stack"),
      composeSource: join(process.resourcesPath, "docker/compose.yaml"),
      sourceDir: null,
      // The images published with this release, so the app and its stack always match.
      // A build run from a checkout's apps/desktop/dist uses the images built there instead.
      images: localBuild() ? null : { prefix: IMAGE_PREFIX, tag: app.getVersion() },
    };
  }
  const repo = resolve(app.getAppPath(), "../..");
  return {
    dir: join(app.getPath("userData"), "stack"),
    composeSource: join(repo, "docker/compose.yaml"),
    sourceDir: repo,
    images: null,
  };
}

let tray: Tray | null = null;
let setupWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let stack: Stack | null = null;
let bridge: Server | null = null;
let hostMcp: HostMcpBridge | null = null;
let settings: Settings = {
  paired: false,
  stopOnQuit: false,
  runServer: null,
  centralUrl: DEFAULT_CENTRAL_URL,
  offeredConnect: false,
  setupDone: false,
  skippedVersion: null,
};
const terminal = new SetupTerminal();
const updates = new AppUpdates({
  skipped: () => settings.skippedVersion,
  skip: (version) => {
    settings.skippedVersion = version;
    void saveSettings(settings);
  },
});

/** The UI the main window shows: this computer's server, or Nibblets Connect. */
const uiUrl = (): string => (settings.runServer ? SERVER_URL : settings.centralUrl);

function step(s: SetupStep) {
  setupWindow?.webContents.send("setup:step", s);
}
function log(line: string) {
  setupWindow?.webContents.send("setup:log", line);
}
function page(p: SetupPage) {
  setupWindow?.webContents.send("setup:page", p);
}

function openSetupWindow(): BrowserWindow {
  if (setupWindow && !setupWindow.isDestroyed()) return setupWindow;
  setupWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 520,
    minHeight: 560,
    title: "Nibblets",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#f0f0f0",
    webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true },
  });
  setupWindow.on("closed", () => terminal.stop());
  void setupWindow.loadFile(join(__dirname, "setup.html"));
  return setupWindow;
}

function openMainWindow(url = uiUrl()) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.getURL() !== url) void mainWindow.loadURL(url);
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Nibblets",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f0f0f0",
    webPreferences: { sandbox: true },
  });
  // Links out of the UI open in the user's browser, not in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    // The UI's own pop-outs (a nibblet's browser) open as app windows.
    if (target.startsWith(new URL("/browser/", uiUrl()).href)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1440,
          height: 960,
          minWidth: 720,
          minHeight: 480,
          backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f0f0f0",
          webPreferences: { sandbox: true },
        },
      };
    }
    openOutside(target);
    return { action: "deny" };
  });
  // The window stays on the UI (and its sign-in); a link elsewhere opens in
  // the browser, so no page can stand in for the app in a window with no URL bar.
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (navigationAllowed(target, uiUrl())) return;
    event.preventDefault();
    openOutside(target);
  });
  // Tells the UI it's in the app, so it can make room for the traffic lights.
  const ua = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(`${ua} NibbletsDesktop/${process.platform}`);
  // The UI is served by the local stack and changes with it; never show a stale copy.
  // If the server was mid-restart, try again rather than sit on an error page.
  mainWindow.webContents.on("did-fail-load", (_e, code, _desc, failed, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is an aborted load, e.g. a redirect.
    setTimeout(() => void mainWindow?.loadURL(failed), 1500);
  });
  void mainWindow.webContents.session.clearCache().finally(() => void mainWindow?.loadURL(url));
}

/**
 * Walks the person through getting Docker and an agent going, checking
 * every few seconds so each one ticks off as it's done. Resolves true when
 * they press Continue, false if they close the window.
 */
function getReady(win: BrowserWindow): Promise<boolean> {
  page("tools");
  return new Promise<boolean>((resolve) => {
    let done = false;
    let ready = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      ipcMain.removeListener("setup:continue", onContinue);
      ipcMain.removeListener("setup:refresh", onRefresh);
      win.removeListener("closed", onClosed);
      resolve(ok);
    };
    const onContinue = () => {
      if (ready) finish(true);
    };
    const onClosed = () => finish(false);
    let checking = false;
    const check = async () => {
      if (done || checking) return;
      checking = true;
      const update = await checkTools().finally(() => (checking = false));
      ready = update.ready;
      if (!done && !win.isDestroyed()) win.webContents.send("setup:tools", update);
    };
    const onRefresh = () => void check();
    ipcMain.on("setup:continue", onContinue);
    ipcMain.on("setup:refresh", onRefresh);
    win.on("closed", onClosed);
    const loop = async () => {
      while (!done) {
        await check();
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    void loop();
  });
}

/** What the setup window may ask for while getting ready. */
function setupIpc(): void {
  const send = (channel: string, value: unknown) => {
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send(channel, value);
  };
  ipcMain.on("setup:action", (_e, tool: unknown, action: unknown) => {
    if (typeof tool !== "string" || typeof action !== "string") return;
    void findAction(tool, action).then(async (found) => {
      if (!found) return;
      if ("open" in found) {
        openOutside(found.open);
        return;
      }
      await terminal
        .run(found.run, {
          data: (chunk) => send("setup:term-data", chunk),
          url: (url) => send("setup:url", url),
          exit: (code) => {
            forgetShellPath();
            send("setup:term-exit", code);
          },
        })
        .catch((err: unknown) =>
          send("setup:term-data", `\r\n${err instanceof Error ? err.message : String(err)}\r\n`),
        );
    });
  });
  ipcMain.on("setup:term-input", (_e, data: unknown) => {
    if (typeof data === "string") terminal.write(data);
  });
  ipcMain.on("setup:term-resize", (_e, cols: unknown, rows: unknown) => {
    if (typeof cols === "number" && typeof rows === "number") terminal.resize(cols, rows);
  });
  ipcMain.on("setup:stop", () => terminal.stop());
  // Only web pages: these come from whatever a command printed.
  const web = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//.test(url);
  ipcMain.on("setup:open-url", (_e, url: unknown) => {
    if (web(url)) openOutside(url);
  });
  ipcMain.on("setup:copy-url", (_e, url: unknown) => {
    if (web(url)) clipboard.writeText(url);
  });
}

/** Docker, credentials, containers, sign-in: each step reported to the setup window. */
async function bringUp(options: { getReady?: boolean } = {}): Promise<void> {
  const win = openSetupWindow();
  await new Promise<void>((r) =>
    win.webContents.isLoading() ? win.webContents.once("did-finish-load", () => r()) : r(),
  );
  if (options.getReady || !settings.setupDone || !(await checkTools()).ready) {
    if (!(await getReady(win))) return;
    settings.setupDone = true;
    await saveSettings(settings);
  }
  page("progress");

  step({ id: "docker", state: "running", detail: "Looking for Docker" });
  const docker = await checkDocker();
  if (docker.state === "missing") {
    step({
      id: "docker",
      state: "error",
      detail:
        "Docker isn't installed. Install Docker Desktop or OrbStack, start it, then try again.",
    });
    return;
  }
  if (docker.state === "stopped") {
    step({
      id: "docker",
      state: "error",
      detail: `Docker is installed but not answering. Start it (or wait for it to finish starting), then try again.\n${docker.detail}`,
    });
    return;
  }
  step({ id: "docker", state: "done", detail: `Docker ${docker.version}` });

  step({
    id: "credentials",
    state: "running",
    detail: "Looking for your agent logins",
  });
  const creds = await detectCredentials();
  const found = [
    creds.claude === "keychain" ? "Claude (keychain)" : creds.claude === "file" ? "Claude" : null,
    creds.codex === "file" ? "ChatGPT" : null,
    existsSync(opencodePaths().auth) ? "OpenCode" : null,
  ].filter((c) => c !== null);
  if (!found.length) {
    step({
      id: "credentials",
      state: "error",
      detail:
        "No logins found. Sign in to Claude Code, Codex, or OpenCode (Set up agents… in the menu bar), then try again.",
    });
    return;
  }
  step({
    id: "credentials",
    state: "done",
    detail: `Sharing ${found.join(" and ")} with your nibblets`,
  });

  step({ id: "stack", state: "running", detail: "Starting containers" });
  stack = new Stack(stackPaths(), docker.cli);
  stack.centralUrl = settings.centralUrl.replace(/\/+$/, "");
  try {
    await stack.prepare(creds);
    if (creds.claude === "keychain" && !bridge) {
      bridge = await startKeychainBridge(stack.env.KEYCHAIN_BRIDGE_TOKEN ?? "");
    }
    if (!hostMcp) {
      // Host MCP servers and CLI logins; nothing reaches a nibblet unless ticked for it.
      hostMcp = await startHostMcpBridge({
        port: HOST_MCP_PORT,
        token: stack.env.HOST_MCP_TOKEN ?? "",
        log: (m) => console.log(m),
        // The web UI's update bar installs the app's updates through this (and the stack's with them).
        updater: updates.host,
      }).catch((err: unknown) => {
        log(`Host tools are off: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    }
    await stack.up(log);
  } catch (err) {
    step({ id: "stack", state: "error", detail: String(err) });
    return;
  }
  step({ id: "stack", state: "done", detail: "Running" });

  if (settings.paired) {
    step({ id: "signin", state: "running", detail: "Waiting for the server" });
    if (!(await stack.waitForServer())) {
      step({ id: "signin", state: "error", detail: "The server didn't come up" });
      return;
    }
    step({ id: "signin", state: "done", detail: "Already signed in" });
    win.close();
    openMainWindow();
    void offerConnect();
    return;
  }
  step({ id: "signin", state: "running", detail: "Waiting for the server" });
  try {
    const url = await stack.pairingUrl();
    settings.paired = true;
    await saveSettings(settings);
    step({ id: "signin", state: "done", detail: "Signed in" });
    win.close();
    openMainWindow(url);
    void offerConnect();
  } catch (err) {
    step({ id: "signin", state: "error", detail: String(err) });
  }
}

/**
 * Once, after a server first comes up here: offer to link it to a Nibblets
 * account, so it shows up on Nibblets Connect. Approving happens in the
 * browser, where the person signs in.
 */
async function offerConnect(): Promise<void> {
  if (settings.offeredConnect || !stack) return;
  const status = await connectStatus();
  if (!status || status.state !== "unlinked") return;
  settings.offeredConnect = true;
  await saveSettings(settings);
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Connect this server to your Nibblets account?",
    detail:
      "Then you can see and use its nibblets from any computer or phone, signed in to Nibblets Connect. You can do this later in Settings → Remote access.",
    buttons: ["Connect", "Not now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await startConnect();
}

const RpcResult = z.object({ ok: z.literal(true), data: ConnectStatus });

async function connectStatus(path = "connect.status"): Promise<ConnectStatus | null> {
  if (!stack) return null;
  const parsed = RpcResult.safeParse(await stack.rpc(path).catch(() => null));
  return parsed.success ? parsed.data.data : null;
}

async function startConnect(): Promise<void> {
  const status = await connectStatus("connect.start");
  if (status?.state === "linking") openOutside(status.approveUrl);
  // The code also shows in Settings → Remote access while it waits.
  openMainWindow(new URL("/settings", SERVER_URL).href);
}

/** Asks, once, whether this computer should run a server or only show servers elsewhere. */
async function askRunServer(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Run a Nibblets server on this computer?",
    detail:
      'A server runs your nibblets here, in Docker, using this computer\'s Claude and ChatGPT logins. If your nibblets live on another machine, choose "Just view" and sign in to Nibblets Connect to see them.',
    buttons: ["Run a server here", "Just view"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/** Starts or stops being a server, from the first-run question or the tray. */
async function setRunServer(run: boolean): Promise<void> {
  settings.runServer = run;
  await saveSettings(settings);
  buildTray();
  if (run) {
    await bringUp();
    return;
  }
  if (stack) await stack.down(() => {}).catch(() => undefined);
  bridge?.close();
  bridge = null;
  await hostMcp?.close();
  hostMcp = null;
  openMainWindow();
}

function buildTray() {
  const iconPath = join(__dirname, "trayTemplate.png");
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  icon.setTemplateImage(true);
  tray ??= new Tray(icon);
  tray.setToolTip("Nibblets");
  const machine = process.platform === "darwin" ? "this Mac" : "this computer";
  const menu = () => {
    const serverItems: MenuItemConstructorOptions[] = [
      { label: "Restart containers", click: () => void bringUp() },
      { label: "Set up agents…", click: () => void bringUp({ getReady: true }) },
      { label: "Connect to your account…", click: () => void startConnect() },
    ];
    const serverOptions: MenuItemConstructorOptions[] = [
      {
        label: "Stop containers on quit",
        type: "checkbox",
        checked: settings.stopOnQuit,
        click: (item) => {
          settings.stopOnQuit = item.checked;
          void saveSettings(settings);
        },
      },
      {
        label: "Sign in again",
        click: () => {
          settings.paired = false;
          void saveSettings(settings).then(() => bringUp());
        },
      },
    ];
    return Menu.buildFromTemplate([
      { label: "Open Nibblets", click: () => openMainWindow() },
      { label: "Check for updates…", click: () => void updates.check(true) },
      {
        label: `Run a server on ${machine}`,
        type: "checkbox",
        checked: settings.runServer === true,
        click: (item) => void setRunServer(item.checked),
      },
      ...(settings.runServer ? serverItems : []),
      { type: "separator" },
      ...(settings.runServer ? [...serverOptions, { type: "separator" as const }] : []),
      { label: "Quit", role: "quit" },
    ]);
  };
  tray.setContextMenu(menu());
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

// `--set-up` opens the getting-ready walkthrough, even on a computer that's done it.
const SET_UP = "--set-up";

app.on("second-instance", (_e, argv) => {
  if (argv.includes(SET_UP) && settings.runServer) void bringUp({ getReady: true });
  else openMainWindow();
});

app.whenReady().then(async () => {
  // Opened from the Dock, the app's PATH is bare; take the person's own, so
  // the CLIs, MCP servers and Docker it starts are the ones their terminal finds.
  await adoptShellPath();
  settings = await loadSettings();
  ipcMain.on("setup:retry", () => void bringUp());
  setupIpc();
  if (settings.runServer === null) {
    settings.runServer = await askRunServer();
    await saveSettings(settings);
  }
  buildTray();
  // With a server, the web UI's update bar offers updates; without one, the app asks itself.
  if (!settings.runServer) updates.start();
  if (settings.runServer) await bringUp({ getReady: process.argv.includes(SET_UP) });
  else openMainWindow();
});

// Closing every window leaves the app in the menu bar; the stack keeps running.
app.on("window-all-closed", () => {});

app.on("activate", () => openMainWindow());

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  bridge?.close();
  void hostMcp?.close();
  if (!settings.stopOnQuit || !stack) return;
  event.preventDefault();
  quitting = true;
  void stack.down(() => {}).finally(() => app.quit());
});
