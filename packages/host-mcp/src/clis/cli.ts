import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a host command. Injected so plugins can be tested without the CLI installed. */
export type Run = (command: string, args: string[]) => Promise<RunResult>;

export interface CliDetection {
  id: string;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /** Who it's signed in as, for "share login as …". */
  account: string | null;
  detail: string | null;
}

export interface CliCredential {
  /** Environment variables the CLI reads its login from inside the container. */
  env: Record<string, string>;
  /** Commands the container runs once after receiving it, e.g. `gh auth setup-git`. */
  setup: string[][];
}

/**
 * A host CLI whose login a nibblet can borrow. Each plugin knows how to
 * tell whether the CLI is installed and signed in, and how to turn the
 * host's login into environment variables the same CLI inside a container
 * understands. Adding a CLI (wrangler, aws, …) is one more of these.
 */
export interface CliPlugin {
  readonly id: string;
  readonly label: string;
  detect(run: Run): Promise<CliDetection>;
  credential(run: Run): Promise<CliCredential>;
}

/**
 * Apps started from Finder get a bare PATH, so the usual install locations
 * are added before looking anything up.
 */
export function hostPath(env: NodeJS.ProcessEnv = process.env): string {
  const extra =
    process.platform === "win32"
      ? []
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local/bin")];
  const parts = [...(env.PATH ?? "").split(delimiter), ...extra].filter((p) => p && existsSync(p));
  return [...new Set(parts)].join(delimiter);
}

export const runOnHost: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 15_000, env: { ...process.env, PATH: hostPath() }, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 127) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
