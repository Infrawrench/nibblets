import { describe, expect, it } from "vitest";
import { formatBytes, opensInBrowser } from "./files.ts";
import { buildTimeline } from "./thread.ts";

describe("files in the UI", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25 MB");
  });

  it("opens viewable files in the browser", () => {
    expect(opensInBrowser("application/pdf")).toBe(true);
    expect(opensInBrowser("application/zip")).toBe(false);
  });

  it("hides share_file calls but keeps the file card", () => {
    const at = "2026-10-14T12:00:00.000Z";
    const timeline = buildTimeline([
      {
        nibbletId: "n",
        seq: 1,
        item: {
          type: "tool_call",
          id: "t1",
          turnId: "turn",
          createdAt: at,
          name: "share_file",
          server: "files",
          input: { path: "a.csv" },
          output: "Shared a.csv with the user.",
          status: "done",
        },
      },
      {
        nibbletId: "n",
        seq: 2,
        item: {
          type: "file",
          id: "file_1",
          turnId: "turn",
          createdAt: at,
          fileId: "file_1",
          name: "a.csv",
          mime: "text/csv",
          size: 8,
          caption: null,
          status: "ready",
          received: 8,
          error: null,
        },
      },
    ]);
    expect(timeline.map((e) => (e.kind === "item" ? e.item.type : e.kind))).toEqual(["file"]);
  });
});
