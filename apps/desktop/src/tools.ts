import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { opencodePaths } from "@nibblet/host-mcp";
import { codexFile, detectCredentials } from "./credentials.ts";
import { checkDocker } from "./docker.ts";

const run = promisify(execFile);

/**
 * What a person needs before a server can run here, as plugins: Docker, and
 * the agents a nibblet can be (any one will do). Each says whether it's
 * installed and signed in, and how to get it there, as commands the setup
 * window runs in its little terminal, or pages to open.
 */
export interface SetupTool {
  id: string;
  name: string;
  /** "engine" must be ready; of the "agent"s, at least one. */
  kind: "engine" | "agent";
  blurb: string;
  check(env: ToolEnv): Promise<ToolState>;
  actions(env: ToolEnv, state: ToolState): ToolAction[];
}

export interface ToolState {
  installed: boolean;
  ready: boolean;
  /** Plain words for where it's at: "Signed in", "Installed, not running". */
  detail: string;
}

export type ToolAction =
  | { id: string; label: string; primary?: boolean; run: string }
  | { id: string; label: string; primary?: boolean; open: string };

/** What the tools can know about this machine. */
export interface ToolEnv {
  platform: NodeJS.Platform;
  /** An executable on the login shell's PATH (plus where installers put things), or null. */
  which(name: string): string | null;
}

/**
 * Apps opened from the Dock get a bare PATH, so commands run in the
 * person's login shell, and lookups use its PATH plus the places
 * installers put things before a new shell would pick them up.
 */
let shellPath: { path: string; at: number } | null = null;
/** Installs change what's on PATH; the next look asks the shell again. */
export function forgetShellPath(): void {
  shellPath = null;
}

export async function toolEnv(): Promise<ToolEnv & { path: string; shell: string }> {
  const shell = loginShell();
  let path = process.env.PATH ?? "";
  if (shellPath && Date.now() - shellPath.at < 60_000) {
    path = shellPath.path;
  } else if (process.platform !== "win32") {
    try {
      const { stdout } = await run(shell, ["-l", "-c", 'printf "%s" "$PATH"'], { timeout: 8000 });
      if (stdout.trim()) path = stdout.trim();
      shellPath = { path, at: Date.now() };
    } catch {
      // A broken shell profile; the extra places below still apply.
    }
  }
  const home = homedir();
  const extra =
    process.platform === "win32"
      ? []
      : [
          join(home, ".local/bin"),
          join(home, ".opencode/bin"),
          join(home, ".claude/local"),
          join(home, ".npm-global/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/Applications/Docker.app/Contents/Resources/bin",
        ];
  const dirs = [...new Set([...path.split(delimiter), ...extra].filter(Boolean))];
  const full = dirs.join(delimiter);
  return {
    platform: process.platform,
    shell,
    path: full,
    which(name) {
      const exe = process.platform === "win32" ? `${name}.exe` : name;
      for (const dir of dirs) {
        const candidate = join(dir, exe);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Not here.
        }
      }
      return null;
    },
  };
}

export function loginShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const unix = (env: ToolEnv) => env.platform !== "win32";

const docker: SetupTool = {
  id: "docker",
  name: "Docker",
  kind: "engine",
  blurb: "Where your nibblets live. Each one gets its own little container.",
  async check() {
    const state = await checkDocker();
    if (state.state === "running")
      return { installed: true, ready: true, detail: `Running (Docker ${state.version})` };
    if (state.state === "stopped")
      return { installed: true, ready: false, detail: "Installed, but not running yet" };
    return { installed: false, ready: false, detail: "Not installed" };
  },
  actions(env, state) {
    const page = "https://www.docker.com/products/docker-desktop/";
    if (state.ready) return [];
    if (state.installed) {
      return env.platform === "darwin"
        ? [{ id: "start", label: "Open Docker", primary: true, run: "open -a Docker" }]
        : [{ id: "help", label: "How to start it", open: "https://docs.docker.com/desktop/" }];
    }
    return env.platform === "darwin" && env.which("brew")
      ? [
          {
            id: "install",
            label: "Install Docker Desktop",
            primary: true,
            run: "brew install --cask docker-desktop && open -a Docker",
          },
          { id: "download", label: "Download instead", open: page },
        ]
      : [{ id: "download", label: "Download Docker Desktop", primary: true, open: page }];
  },
};

const claude: SetupTool = {
  id: "claude",
  name: "Claude Code",
  kind: "agent",
  blurb: "Uses your Claude subscription. The usual choice.",
  async check(env) {
    const bin = env.which("claude");
    const creds = await detectCredentials();
    const ready = creds.claude !== "none";
    return {
      installed: bin !== null || ready,
      ready,
      detail: ready ? "Signed in" : bin ? "Installed, not signed in" : "Not installed",
    };
  },
  actions(env, state) {
    if (state.ready) return [];
    const bin = env.which("claude");
    if (bin)
      return [{ id: "login", label: "Sign in", primary: true, run: `${quote(bin)} auth login` }];
    return unix(env)
      ? [
          {
            id: "install",
            label: "Install",
            primary: true,
            run: "curl -fsSL https://claude.ai/install.sh | bash",
          },
        ]
      : [
          {
            id: "install",
            label: "How to install",
            open: "https://docs.claude.com/en/docs/claude-code/setup",
          },
        ];
  },
};

const codex: SetupTool = {
  id: "codex",
  name: "Codex",
  kind: "agent",
  blurb: "Uses your ChatGPT subscription.",
  async check(env) {
    const bin = env.which("codex");
    const ready = existsSync(codexFile);
    return {
      installed: bin !== null || ready,
      ready,
      detail: ready ? "Signed in" : bin ? "Installed, not signed in" : "Not installed",
    };
  },
  actions(env, state) {
    if (state.ready) return [];
    const bin = env.which("codex");
    if (bin) return [{ id: "login", label: "Sign in", primary: true, run: `${quote(bin)} login` }];
    const install = env.which("brew")
      ? "brew install --cask codex"
      : env.which("npm")
        ? "npm install -g @openai/codex"
        : null;
    return install
      ? [{ id: "install", label: "Install", primary: true, run: install }]
      : [{ id: "install", label: "How to install", open: "https://github.com/openai/codex" }];
  },
};

const opencode: SetupTool = {
  id: "opencode",
  name: "OpenCode",
  kind: "agent",
  blurb: "Bring your own provider: API keys, GitHub Copilot, and more.",
  async check(env) {
    const bin = env.which("opencode");
    const ready = existsSync(opencodePaths().auth);
    return {
      installed: bin !== null || ready,
      ready,
      detail: ready ? "Signed in" : bin ? "Installed, not signed in" : "Not installed",
    };
  },
  actions(env, state) {
    if (state.ready) return [];
    const bin = env.which("opencode");
    if (bin)
      return [{ id: "login", label: "Sign in", primary: true, run: `${quote(bin)} auth login` }];
    return unix(env)
      ? [
          {
            id: "install",
            label: "Install",
            primary: true,
            run: "curl -fsSL https://opencode.ai/install | bash",
          },
        ]
      : [{ id: "install", label: "How to install", open: "https://opencode.ai/docs/" }];
  },
};

export const setupTools: readonly SetupTool[] = [docker, claude, codex, opencode];

export interface ToolReport {
  id: string;
  name: string;
  kind: SetupTool["kind"];
  blurb: string;
  state: ToolState;
  actions: { id: string; label: string; primary: boolean; kind: "run" | "open" }[];
}

/** Everything checked at once, for the setup window. */
export async function checkTools(): Promise<{ reports: ToolReport[]; ready: boolean }> {
  const env = await toolEnv();
  const reports = await Promise.all(
    setupTools.map(async (tool): Promise<ToolReport> => {
      const state = await tool
        .check(env)
        .catch(() => ({ installed: false, ready: false, detail: "Couldn't check" }));
      return {
        id: tool.id,
        name: tool.name,
        kind: tool.kind,
        blurb: tool.blurb,
        state,
        actions: tool.actions(env, state).map((a) => ({
          id: a.id,
          label: a.label,
          primary: a.primary ?? false,
          kind: "run" in a ? "run" : "open",
        })),
      };
    }),
  );
  return { reports, ready: readyToGo(reports) };
}

/** The engine running, and at least one agent signed in. */
export function readyToGo(reports: readonly Pick<ToolReport, "kind" | "state">[]): boolean {
  return (
    reports.filter((r) => r.kind === "engine").every((r) => r.state.ready) &&
    reports.some((r) => r.kind === "agent" && r.state.ready)
  );
}

/** Looks an action up again by id, so the window can only ask for what's on offer. */
export async function findAction(toolId: string, actionId: string): Promise<ToolAction | null> {
  const tool = setupTools.find((t) => t.id === toolId);
  if (!tool) return null;
  const env = await toolEnv();
  const state = await tool.check(env);
  return tool.actions(env, state).find((a) => a.id === actionId) ?? null;
}
