import { CONTAINER_SSH_AUTH_SOCK } from "@nibblet/protocol";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CliPlugin, Run, RunResult } from "./cli.ts";

/** The keys `ssh-add -l` lists: "256 SHA256:… comment (ED25519)". */
export function parseSshAddList(result: RunResult): { comment: string; type: string }[] {
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => /^\d+\s+\S+\s+(.*?)\s+\((\w+)\)\s*$/.exec(line.trim()))
    .filter((m) => m !== null)
    .map((m) => ({ comment: m[1] ?? "", type: (m[2] ?? "").toLowerCase() }));
}

/** Private keys in a directory: any file with a matching `.pub` beside it. */
export function keyFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const all = new Set(names);
  return names
    .filter((n) => !n.endsWith(".pub") && all.has(`${n}.pub`))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Puts the host's keys into its own agent, so a nibblet borrowing the agent
 * can use them. On a Mac, keys whose passphrases are in the keychain go in
 * first; then each key file is offered, and ones that need a passphrase
 * nobody can type here are skipped. Keys already loaded are left alone.
 */
async function loadKeys(run: Run, files: string[]): Promise<void> {
  if (process.platform === "darwin") await run("ssh-add", ["-q", "--apple-load-keychain"]);
  for (const file of files) await run("ssh-add", ["-q", file]);
}

/**
 * The host's SSH keys, through its agent. Nothing is copied: keys in
 * `~/.ssh` are loaded into the host's own agent, and the server mounts that
 * agent's socket into the nibblet's container, so it can sign with them while
 * the keys themselves never leave the host.
 */
export function createSshPlugin(sshDir = join(homedir(), ".ssh")): CliPlugin {
  return {
    id: "ssh",
    label: "SSH keys",
    async detect(run) {
      const base = { id: "ssh", label: "SSH keys" };
      const version = await run("ssh", ["-V"]);
      if (version.code !== 0) {
        return { ...base, installed: false, signedIn: false, account: null, detail: null };
      }
      const files = keyFiles(sshDir);
      const listed = await run("ssh-add", ["-l"]);
      const loaded = parseSshAddList(listed);
      if (files.length === 0 && loaded.length === 0) {
        const detail =
          listed.code === 2
            ? "No SSH agent is running on the host"
            : "No keys in ~/.ssh or the host's agent";
        return { ...base, installed: true, signedIn: false, account: null, detail };
      }
      const count = Math.max(files.length, loaded.length);
      const account = count === 1 ? "1 key" : `${count} keys`;
      const detail = files.length > 0 ? files.map((f) => basename(f)).join(", ") : null;
      return { ...base, installed: true, signedIn: true, account, detail };
    },
    async credential(run) {
      await loadKeys(run, keyFiles(sshDir));
      return {
        env: { SSH_AUTH_SOCK: CONTAINER_SSH_AUTH_SOCK },
        // Containers start with an empty known_hosts; trust a host on first use.
        setup: [
          [
            "git",
            "config",
            "--global",
            "core.sshCommand",
            "ssh -o StrictHostKeyChecking=accept-new",
          ],
        ],
      };
    },
  };
}

export const sshPlugin = createSshPlugin();
