import { execFile } from "node:child_process";
import type { CliLogin } from "@nibblets/protocol";

export type Exec = (command: string, args: string[]) => Promise<void>;

const execHost: Exec = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (err) => (err ? reject(err) : resolve()));
  });

/**
 * Puts borrowed host CLI logins into this process's environment, which
 * every harness copies into the agents it starts, and runs each CLI's
 * one-time setup (e.g. `gh auth setup-git`). Variables from logins that
 * were taken away are removed again.
 */
export class CliLogins {
  private applied = new Map<string, string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: Exec;

  constructor(env: NodeJS.ProcessEnv = process.env, exec: Exec = execHost) {
    this.env = env;
    this.exec = exec;
  }

  /** Applies `logins`; returns the setup failures, which never include values. */
  async apply(logins: readonly CliLogin[]): Promise<string[]> {
    const next = new Map<string, string>();
    for (const login of logins) for (const [k, v] of Object.entries(login.env)) next.set(k, v);
    for (const key of this.applied.keys()) if (!next.has(key)) delete this.env[key];
    for (const [k, v] of next) this.env[k] = v;
    const changed = logins.filter((l) =>
      Object.entries(l.env).some(([k, v]) => this.applied.get(k) !== v),
    );
    this.applied = next;

    const failures: string[] = [];
    for (const login of changed) {
      for (const [command, ...args] of login.setup) {
        if (!command) continue;
        await this.exec(command, args).catch(() =>
          failures.push(`${login.id}: \`${[command, ...args].join(" ")}\` failed`),
        );
      }
    }
    return failures;
  }
}
