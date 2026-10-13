import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { ipcMain } from "electron/main";
import { startHostMcpBridge, type HostMcpBridge } from "@nibblet/host-mcp";
import { startKeychainBridge } from "./bridge.ts";
import { detectCredentials } from "./credentials.ts";
import { checkDocker } from "./docker.ts";
import type { SetupStep } from "./preload.ts";
import { HOST_MCP_PORT, Stack } from "./stack.ts";

const UI_URL = "http://127.0.0.1:8420/";

interface Settings {
  paired: boolean;
  stopOnQuit: boolean;
}

const settingsPath = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<Settings> {
  const defaults: Settings = { paired: false, stopOnQuit: false };
  try {
    const parsed: Partial<Settings> = JSON.parse(await readFile(settingsPath(), "utf8"));
    return { ...defaults, ...parsed };
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
let settings: Settings = { paired: false, stopOnQuit: false };

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

function openMainWindow(url = UI_URL) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (url !== UI_URL) void mainWindow.loadURL(url);
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
    void shell.openExternal(target);
    return { action: "deny" };
  });
  // Tells the UI it's in the app, so it can make room for the traffic lights.
  const ua = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(`${ua} NibbletsDesktop/${process.platform}`);
  // The UI is served by the local stack and changes with it; never show a stale copy.
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
    step({ id: "signin", state: "done", detail: "Already signed in" });
    win.close();
    openMainWindow();
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
  } catch (err) {
    step({ id: "signin", state: "error", detail: String(err) });
  }
}

function buildTray() {
  const iconPath = join(__dirname, "trayTemplate.png");
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Nibblets");
  const menu = () =>
    Menu.buildFromTemplate([
      { label: "Open Nibblets", click: () => openMainWindow() },
      { label: "Restart containers", click: () => void bringUp() },
      { type: "separator" },
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
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]);
  tray.setContextMenu(menu());
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on("second-instance", () => openMainWindow());

app.whenReady().then(async () => {
  settings = await loadSettings();
  ipcMain.on("setup:retry", () => void bringUp());
  buildTray();
  await bringUp();
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
