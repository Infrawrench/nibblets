import { spawn } from "node:child_process";

/** What's shared by the entry's platforms. */

/** Some of the entry's own environment, by name. */
export const pick = (keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    keys.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] ?? ""]])),
  );

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs a command with this process's stdio, failing as it fails. */
export function inherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
