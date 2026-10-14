import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Apps opened from the Dock or Finder get launchd's bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so nothing from Homebrew, nvm or
 * ~/.local/bin is found: not docker, not the agents' CLIs, not the npx a
 * host MCP server starts with. The person's own PATH comes from their shell,
 * and an interactive one, since nvm and friends set up in ~/.zshrc.
 */

const MARK = "__NIBBLETS_PATH__";

/** The PATH between the markers, ignoring whatever else a shell's config prints. */
export function parseShellPath(output: string): string | null {
  const found = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(output);
  const path = found?.[1]?.trim();
  return path ? path : null;
}

/** Joins PATH lists, dropping blanks and repeats and keeping the first of each. */
export function mergePaths(...lists: string[]): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dir of list.split(delimiter)) if (dir) seen.add(dir);
  }
  return [...seen].join(delimiter);
}

export function loginShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

/** Where installers put things, for when a shell can't say. */
export function installDirs(home = homedir()): string[] {
  return [
    join(home, ".local/bin"),
    join(home, ".opencode/bin"),
    join(home, ".claude/local"),
    join(home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    join(home, "Applications/Docker.app/Contents/Resources/bin"),
    join(home, ".orbstack/bin"),
  ];
}

function run(shell: string, flags: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      [flags, `printf '${MARK}%s${MARK}' "$PATH"`],
      // A dumb terminal, so prompts and themes keep quiet.
      { timeout: timeoutMs, env: { ...process.env, TERM: "dumb" } },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** The shell's PATH: interactive login first, then plain login. Null if neither says. */
export async function shellPath(shell = loginShell(), timeoutMs = 10_000): Promise<string | null> {
  if (process.platform === "win32") return null;
  for (const flags of ["-ilc", "-lc"]) {
    try {
      const path = parseShellPath(await run(shell, flags, timeoutMs));
      if (path) return path;
    } catch {
      // A broken or slow shell config; try the next way.
    }
  }
  return null;
}

/**
 * Gives this process the person's PATH, so everything it starts (the host
 * bridge's CLIs and MCP servers, Docker, the setup terminal) finds what their
 * terminal would. Returns the PATH it settled on.
 */
export async function adoptShellPath(): Promise<string> {
  const path = mergePaths(
    (await shellPath()) ?? "",
    process.env.PATH ?? "",
    process.platform === "win32" ? "" : installDirs().join(delimiter),
  );
  process.env.PATH = path;
  return path;
}
