import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
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
import type { SetupStep } from "./preload.ts";
import { HOST_MCP_PORT, Stack } from "./stack.ts";

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
}

const settingsPath = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Settings> {
  const defaults: Settings = {
    paired: false,
    stopOnQuit: false,
    runServer: null,
    centralUrl: DEFAULT_CENTRAL_URL,
    offeredConnect: false,
  };
  try {
    const parsed: Partial<Settings> = JSON.parse(await readFile(settingsPath(), "utf8"));
    // Installs from before the question was asked were already running a server.
    const runServer = parsed.runServer ?? (parsed.paired ? true : null);
    return { ...defaults, ...parsed, runServer };
  } catch {
    return defaults;
  }
}

const saveSettings = (s: Settings) => writeFile(settingsPath(), JSON.stringify(s, null, 2));

/** In a checkout the repo is two levels above this app; packaged, the compose file is a resource. */
function stackPaths() {
  if (app.isPackaged) {
    return {
      dir: join(app.getPath("userData"), "stack"),
      composeSource: join(process.resourcesPath, "docker/compose.yaml"),
      sourceDir: null,
    };
  }
  const repo = resolve(app.getAppPath(), "../..");
  return {
    dir: join(app.getPath("userData"), "stack"),
    composeSource: join(repo, "docker/compose.yaml"),
    sourceDir: repo,
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
};

/** The UI the main window shows: this computer's server, or Nibblets Connect. */
const uiUrl = (): string => (settings.runServer ? SERVER_URL : settings.centralUrl);

function step(s: SetupStep) {
  setupWindow?.webContents.send("setup:step", s);
}
function log(line: string) {
  setupWindow?.webContents.send("setup:log", line);
}

function openSetupWindow(): BrowserWindow {
  if (setupWindow && !setupWindow.isDestroyed()) return setupWindow;
  setupWindow = new BrowserWindow({
    width: 520,
    height: 470,
    resizable: false,
    title: "Nibblets",
    webPreferences: { preload: join(__dirname, "preload.cjs"), sandbox: true },
  });
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
    void shell.openExternal(target);
    return { action: "deny" };
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

/** Docker, credentials, containers, sign-in: each step reported to the setup window. */
async function bringUp(): Promise<void> {
  const win = openSetupWindow();
  await new Promise<void>((r) =>
    win.webContents.isLoading() ? win.webContents.once("did-finish-load", () => r()) : r(),
  );

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
    detail: "Looking for your Claude and ChatGPT logins",
  });
  const creds = await detectCredentials();
  const found = [
    creds.claude === "keychain" ? "Claude (keychain)" : creds.claude === "file" ? "Claude" : null,
    creds.codex === "file" ? "ChatGPT" : null,
  ].filter((c) => c !== null);
  if (!found.length) {
    step({
      id: "credentials",
      state: "error",
      detail:
        "No logins found. Sign in with `claude` (Claude Code) or `codex login`, then try again.",
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
  if (status?.state === "linking") void shell.openExternal(status.approveUrl);
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
          void saveSettings(settings).then(bringUp);
        },
      },
    ];
    return Menu.buildFromTemplate([
      { label: "Open Nibblets", click: () => openMainWindow() },
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

app.on("second-instance", () => openMainWindow());

app.whenReady().then(async () => {
  settings = await loadSettings();
  ipcMain.on("setup:retry", () => void bringUp());
  if (settings.runServer === null) {
    settings.runServer = await askRunServer();
    await saveSettings(settings);
  }
  buildTray();
  if (settings.runServer) await bringUp();
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
