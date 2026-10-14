import { app, dialog } from "electron";
import { openOutside } from "./links.ts";
import { compareVersions, latestRelease, type AppRelease } from "@nibblet/protocol";

const REPO = "Infrawrench/nibblets";
const CHECK_EVERY_MS = 12 * 60 * 60_000;

/**
 * Offers new releases of the app: a dialog with what's new and a link to
 * download it. A version the person skips isn't offered again.
 */
export class AppUpdates {
  private timer: ReturnType<typeof setInterval> | null = null;
  private open = false;
  private readonly skipped: () => string | null;
  private readonly skip: (version: string) => void;

  constructor(opts: { skipped: () => string | null; skip: (version: string) => void }) {
    this.skipped = opts.skipped;
    this.skip = opts.skip;
  }

  start(): void {
    setTimeout(() => void this.check(false), 30_000);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** `manual` is the menu item: it says so when there's nothing new, and ignores skipping. */
  async check(manual: boolean): Promise<void> {
    if (this.open) return;
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
    this.open = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: `Nibblets ${latest.version} is out`,
        detail: `You have ${current}.${latest.notes ? `\n\n${trimNotes(latest.notes)}` : ""}`,
        buttons: ["Download", "Later", "Skip this version"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) openOutside(latest.url);
      if (response === 2) this.skip(latest.version);
    } finally {
      this.open = false;
    }
  }
}

/** Release notes, short enough for a dialog. */
export function trimNotes(notes: string, max = 600): string {
  const text = notes.replace(/\r/g, "").trim();
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}
