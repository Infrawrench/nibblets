import { CONTAINER_SSH_AUTH_SOCK } from "@nibblet/protocol";
import type { CliPlugin, RunResult } from "./cli.ts";

/** The keys `ssh-add -l` lists: "256 SHA256:… comment (ED25519)". */
export function parseSshAddList(result: RunResult): { comment: string; type: string }[] {
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => /^\d+\s+\S+\s+(.*?)\s+\((\w+)\)\s*$/.exec(line.trim()))
    .filter((m) => m !== null)
    .map((m) => ({ comment: m[1] ?? "", type: (m[2] ?? "").toLowerCase() }));
}

/**
 * The host's SSH agent. Nothing is copied: the server mounts the agent's
 * socket into the nibblet's container, so it can sign with the host's keys
 * while the keys themselves never leave the host.
 */
export const sshPlugin: CliPlugin = {
  id: "ssh",
  label: "SSH keys",
  async detect(run) {
    const base = { id: "ssh", label: "SSH keys" };
    const version = await run("ssh", ["-V"]);
    if (version.code !== 0) {
      return { ...base, installed: false, signedIn: false, account: null, detail: null };
    }
    const listed = await run("ssh-add", ["-l"]);
    const keys = parseSshAddList(listed);
    if (keys.length === 0) {
      // 1 is "no identities", 2 is "no agent".
      const detail =
        listed.code === 2
          ? "No SSH agent is running on the host"
          : "Add a key to the host's agent with `ssh-add`";
      return { ...base, installed: true, signedIn: false, account: null, detail };
    }
    const first = keys[0];
    const account =
      keys.length === 1 && first
        ? `${first.comment || "1 key"} (${first.type})`
        : `${keys.length} keys from the agent`;
    return { ...base, installed: true, signedIn: true, account, detail: null };
  },
  async credential() {
    return {
      env: { SSH_AUTH_SOCK: CONTAINER_SSH_AUTH_SOCK },
      // Containers start with an empty known_hosts; trust a host on first use.
      setup: [
        ["git", "config", "--global", "core.sshCommand", "ssh -o StrictHostKeyChecking=accept-new"],
      ],
    };
  },
};
