import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Apps launched from Finder get a bare PATH, so the docker CLI is looked
 * for where each engine installs it rather than trusted to be on PATH.
 */
export function findDockerCli(): string | null {
  const windows = process.platform === "win32";
  const exe = windows ? "docker.exe" : "docker";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, exe)),
    ...(windows
      ? [
          join(programFiles, "Docker", "Docker", "resources", "bin", exe),
          join(homedir(), ".rd", "bin", exe),
        ]
      : [
          "/usr/local/bin/docker",
          "/opt/homebrew/bin/docker",
          "/Applications/Docker.app/Contents/Resources/bin/docker",
          // Where the setup window puts it when /Applications isn't writable.
          join(homedir(), "Applications/Docker.app/Contents/Resources/bin/docker"),
          join(homedir(), ".orbstack/bin/docker"),
          join(homedir(), ".rd/bin/docker"),
          "/usr/bin/docker",
        ]),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** The engine's socket, in the order the docker CLI itself would pick one. */
export async function findDockerSocket(cli: string | null): Promise<string | null> {
  const fromHost = process.env.DOCKER_HOST;
  if (fromHost?.startsWith("unix://")) return fromHost.slice("unix://".length);
  if (cli) {
    try {
      const { stdout } = await run(
        cli,
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        {
          timeout: 5000,
        },
      );
      const host = stdout.trim();
      if (host.startsWith("unix://") && existsSync(host.slice(7))) return host.slice(7);
    } catch {
      // No CLI context; fall through to the usual places.
    }
  }
  const sockets = [
    join(homedir(), ".docker/run/docker.sock"),
    join(homedir(), ".orbstack/run/docker.sock"),
    "/var/run/docker.sock",
  ];
  return sockets.find((p) => existsSync(p)) ?? null;
}

export type DockerState =
  | { state: "missing" }
  | { state: "stopped"; cli: string; detail: string }
  | { state: "running"; cli: string; version: string };

/**
 * Whether Docker is usable. Never starts or restarts the engine: that's
 * the user's machine, and a hung engine needs them, not us.
 */
export async function checkDocker(): Promise<DockerState> {
  const cli = findDockerCli();
  if (!cli) return { state: "missing" };
  try {
    const { stdout } = await run(cli, ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15000,
    });
    return { state: "running", cli, version: stdout.trim() };
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n").slice(-2).join(" ") : String(err);
    return { state: "stopped", cli, detail };
  }
}
