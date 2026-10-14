import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ToolReport } from "./tools.ts";

export interface SetupStep {
  id: "docker" | "credentials" | "stack" | "signin";
  state: "pending" | "running" | "done" | "error";
  detail: string;
}

export interface ToolsUpdate {
  reports: ToolReport[];
  ready: boolean;
}

/** The setup window's side: "tools" gets the machine ready, "progress" starts the server. */
export type SetupPage = "tools" | "progress";

const on =
  <T>(channel: string) =>
  (cb: (value: T) => void) => {
    ipcRenderer.on(channel, (_e: IpcRendererEvent, value: T) => cb(value));
  };

const api = {
  onStep: on<SetupStep>("setup:step"),
  onLog: on<string>("setup:log"),
  onPage: on<SetupPage>("setup:page"),
  onTools: on<ToolsUpdate>("setup:tools"),
  onTermData: on<string>("setup:term-data"),
  onTermExit: on<number>("setup:term-exit"),
  onUrl: on<string>("setup:url"),
  retry: () => ipcRenderer.send("setup:retry"),
  continueSetup: () => ipcRenderer.send("setup:continue"),
  refreshTools: () => ipcRenderer.send("setup:refresh"),
  runAction: (tool: string, action: string) => ipcRenderer.send("setup:action", tool, action),
  stopCommand: () => ipcRenderer.send("setup:stop"),
  termInput: (data: string) => ipcRenderer.send("setup:term-input", data),
  termResize: (cols: number, rows: number) => ipcRenderer.send("setup:term-resize", cols, rows),
  openUrl: (url: string) => ipcRenderer.send("setup:open-url", url),
  copyUrl: (url: string) => ipcRenderer.send("setup:copy-url", url),
};

export type NibbletSetupApi = typeof api;

contextBridge.exposeInMainWorld("nibbletSetup", api);
