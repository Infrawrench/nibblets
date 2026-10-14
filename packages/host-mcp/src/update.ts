import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Run } from "./clis/cli.ts";

export interface UpdateState {
  /** "here": this host installs it; "download": the person gets a new app; "manual": neither. */
  method: "here" | "download" | "manual";
  updating: boolean;
  error: string | null;
}

/** How the host installs a new Nibblets, if it can. A plugin, so each kind of install brings its own. */
export interface AppUpdaterHost {
  describe(): Promise<UpdateState>;
  /** Starts installing `version`; returns once it's under way. */
  apply(version: string): Promise<void>;
}

/**
 * For a checkout set up by install.sh: checks out the release's tag and
 * reruns docker/up.sh, which pulls the release's images and restarts the stack. Under systemd
 * the bridge then exits, to be restarted on the new code.
 */
export function gitUpdater(repo: string, run: Run, logFile = defaultLog()): AppUpdaterHost {
  let updating = false;
  let error: string | null = null;
  return {
    async describe() {
      if (!existsSync(join(repo, ".git"))) return { method: "manual", updating, error };
      // Without Docker access as this user (rootful Podman needs sudo), the installer has to do it.
      const docker = await run("docker", ["info"]).catch(() => null);
      return { method: docker?.code === 0 ? "here" : "manual", updating, error };
    },
    async apply(version) {
      if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Not a version: ${version}`);
      if (updating) return;
      const tag = `v${version}`;
      await mkdir(join(logFile, ".."), { recursive: true });
      const log = await open(logFile, "w");
      const child = spawn(
        "sh",
        [
          "-c",
          `git fetch --depth 1 origin tag ${tag} && git checkout -q --detach ${tag} && sh docker/up.sh`,
        ],
        { cwd: repo, stdio: ["ignore", log.fd, log.fd] },
      );
      updating = true;
      error = null;
      child.on("exit", (code) => {
        updating = false;
        void log.close();
        if (code === 0) {
          if (process.env.INVOCATION_ID) setTimeout(() => process.exit(0), 1000);
          return;
        }
        void readFile(logFile, "utf8").then((text) => {
          const tail = text.trim().split("\n").slice(-3).join(" ");
          error = `The update to ${version} didn't finish${tail ? `: ${tail}` : ""}. The log is in ${logFile}.`;
        });
      });
    },
  };
}

function defaultLog(): string {
  return join(homedir(), ".local", "share", "nibblets", "update.log");
}
