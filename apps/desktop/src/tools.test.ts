import { describe, expect, it } from "vitest";
import { installCodex, installDockerDesktop, setupTools, type ToolEnv } from "./tools.ts";

/** A Mac with nothing on it: no Homebrew, no npm. */
const bareMac: ToolEnv = { platform: "darwin", which: () => null };
const missing = { installed: false, ready: false, detail: "Not installed" };

const actionsFor = (id: string, env: ToolEnv) => {
  const tool = setupTools.find((t) => t.id === id);
  if (!tool) throw new Error(`no ${id}`);
  return tool.actions(env, missing);
};

describe("setup on a Mac without Homebrew", () => {
  it("installs Docker Desktop from Docker's own DMG, with a download as the fallback", () => {
    expect(actionsFor("docker", bareMac)).toEqual([
      { id: "install", label: "Install Docker Desktop", primary: true, run: installDockerDesktop },
      { id: "download", label: "Download instead", open: expect.any(String) },
    ]);
  });

  it("installs Codex from its GitHub release", () => {
    expect(actionsFor("codex", bareMac)).toEqual([
      { id: "install", label: "Install", primary: true, run: installCodex },
    ]);
  });

  it("can install every agent in the window", () => {
    for (const id of ["claude", "codex", "opencode"]) {
      expect(actionsFor(id, bareMac).some((a) => "run" in a)).toBe(true);
    }
  });
});
