import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { openOutside } from "./links.ts";
import { formatNotes } from "./notes.ts";
import type { AppUpdaterHost } from "@nibblet/host-mcp";
import { compareVersions, latestRelease, type AppRelease } from "@nibblet/protocol";

const REPO = "Infrawrench/nibblets";
const CHECK_EVERY_MS = 12 * 60 * 60_000;
/** Where to get it by hand: the site leads with the right download for this machine. */
const DOWNLOAD_PAGE = "https://nibblets.dev";

/**
 * New releases of the app. On a Mac the app installs them itself
 * (electron-updater, from the release's latest-mac.yml and zips) and
 * restarts, which also moves its stack onto the release's images; elsewhere
 * they're a new download.
 *
 * Usually the web UI's update bar asks, through the host bridge (`host`).
 * Without a server to show it, and from the menu, a dialog with what's new
 * asks instead; a version the person skips there isn't offered again.
 */
export class AppUpdates {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private installing = false;
  private installError: string | null = null;
  private progress: number | null = null;
  private readonly skipped: () => string | null;
  private readonly skip: (version: string) => void;

  constructor(opts: { skipped: () => string | null; skip: (version: string) => void }) {
    this.skipped = opts.skipped;
    this.skip = opts.skip;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }

  start(): void {
    setTimeout(() => void this.check(false), 30_000);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** For the host bridge, so the web UI's update bar can start it: one click, no questions. */
  readonly host: AppUpdaterHost = {
    describe: async () => ({
      method: this.installsItself ? "here" : "download",
      updating: this.installing,
      error: this.installError,
      progress: this.installing ? this.progress : null,
    }),
    apply: async (version) => {
      if (!this.installsItself) throw new Error("Download the new version of the app instead");
      if (this.installing) return;
      void this.download(version).catch((err: unknown) => {
        this.installError = `Couldn't install ${version}: ${err instanceof Error ? err.message : String(err)}`;
      });
    },
  };

  /**
   * Release builds for the Mac install updates themselves; anything else is a
   * new download. Local builds (`pnpm run package`) lack the updater's
   * settings file, and their unsigned app couldn't take a signed update anyway.
   */
  private get installsItself(): boolean {
    return (
      process.platform === "darwin" &&
      app.isPackaged &&
      existsSync(join(process.resourcesPath, "app-update.yml"))
    );
  }

  /** `manual` is the menu item: it says so when there's nothing new, and ignores skipping. */
  async check(manual: boolean): Promise<void> {
    if (this.busy) return;
    let latest: AppRelease | null;
    try {
      latest = await latestRelease(REPO);
    } catch (err) {
      if (manual) {
        void dialog.showMessageBox({
          type: "warning",
          message: "Couldn't check for updates",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const current = app.getVersion();
    const newer = latest !== null && compareVersions(latest.version, current) > 0;
    if (!latest || !newer) {
      if (manual) {
        void dialog.showMessageBox({
          type: "info",
          message: "Nibblets is up to date",
          detail: `You have version ${current}.`,
        });
      }
      return;
    }
    if (!manual && this.skipped() === latest.version) return;
    this.busy = true;
    try {
      const notes = formatNotes(latest.notes);
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `Nibblets ${latest.version} is out`,
        detail: `You have ${current}.${notes ? `\n\n${notes}` : ""}`,
        buttons: [
          this.installsItself ? "Install and Restart" : "Download",
          "Later",
          "Skip this version",
        ],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 2) this.skip(latest.version);
      if (response !== 0) return;
      if (!this.installsItself) {
        openOutside(DOWNLOAD_PAGE);
        return;
      }
      await this.download(latest.version).catch(async (err: unknown) => {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          message: `Couldn't install Nibblets ${latest.version}`,
          detail: `${err instanceof Error ? err.message : String(err)}\n\nYou can download it instead.`,
          buttons: ["Download", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) openOutside(DOWNLOAD_PAGE);
      });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Downloads the update, showing progress on the Dock icon, then quits
   * (stopping the stack first if that's the setting) and opens the new version.
   */
  private async download(version: string): Promise<void> {
    const progress = (fraction: number) => {
      // The update bar shows it too, through the host bridge; the Dock's 2 is "not started yet".
      this.progress = fraction >= 0 && fraction <= 1 ? fraction : null;
      for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(fraction);
    };
    const onProgress = (p: { percent: number }) => progress(p.percent / 100);
    this.installing = true;
    this.installError = null;
    autoUpdater.on("download-progress", onProgress);
    try {
      progress(2); // Indeterminate until the download starts.
      const found = await autoUpdater.checkForUpdates();
      if (!found?.isUpdateAvailable || found.updateInfo.version !== version) {
        throw new Error(`version ${version} can't be installed from inside the app.`);
      }
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall();
    } finally {
      progress(-1);
      autoUpdater.off("download-progress", onProgress);
      this.installing = false;
    }
  }
}
