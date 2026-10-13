import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface SetupStep {
  id: "docker" | "credentials" | "stack" | "signin";
  state: "pending" | "running" | "done" | "error";
  detail: string;
}

contextBridge.exposeInMainWorld("nibbletSetup", {
  onStep(cb: (step: SetupStep) => void) {
    ipcRenderer.on("setup:step", (_e: IpcRendererEvent, step: SetupStep) => cb(step));
  },
  onLog(cb: (line: string) => void) {
    ipcRenderer.on("setup:log", (_e: IpcRendererEvent, line: string) => cb(line));
  },
  retry() {
    ipcRenderer.send("setup:retry");
  },
});
