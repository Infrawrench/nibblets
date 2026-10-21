import type { McpServerSpec } from "@nibblets/harness";
import type { BackgroundTask } from "@nibblets/protocol";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { serveMcp, toolReply } from "./mcp-http.ts";

/** Finished tasks kept in the list, newest first, before the oldest are forgotten. */
const KEEP_FINISHED = 20;
/** How long a stopped task gets to exit before it's killed. */
const STOP_GRACE_MS = 10_000;
/**
 * How long tasks get to exit when the container stops, before they're
 * killed: enough for a game server to save. Fits inside the entry's wait
 * and the server's `docker stop` timeout.
 */
export const SHUTDOWN_GRACE_MS = 8_000;
/** How much of a log's end `output` reads, at most. */
const TAIL_BYTES = 256 * 1024;
/** A log longer than this is cut back to its last KEEP_LOG_BYTES. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const KEEP_LOG_BYTES = 1024 * 1024;
/** How often logs are measured, and a finished leader's group is checked on. */
const CHECK_EVERY_MS = 1_000;

export interface BackgroundTasksOptions {
  workdir: string;
  /** Where the logs go; emptied on start, since the tasks they belong to are gone. */
  logDir: string;
  /** Called with the whole list whenever it changes. */
  onChange?: (tasks: BackgroundTask[]) => void;
  /** Overrides STOP_GRACE_MS, for tests. */
  stopGraceMs?: number;
  /** Overrides MAX_LOG_BYTES and KEEP_LOG_BYTES, for tests. */
  maxLogBytes?: number;
  keepLogBytes?: number;
}

interface Running {
  task: BackgroundTask;
  child: ChildProcess | null;
  log: string;
  /** The command's own exit code, once it's exited; what it started may still be running. */
  leaderCode?: number | null;
}

/** The last `lines` lines of some text, without a trailing empty one. */
export function lastLines(text: string, lines: number): string {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}

/**
 * Long-running processes the agent starts with `task_start`: servers and
 * watchers that have to outlive the shell command (and the turn) that
 * started them. Each runs in its own process group as the agent's user, with
 * its output going to a log file that `task_output` and the user's terminal
 * read. They end when the container does.
 */
export class BackgroundTasks {
  private readonly opts: BackgroundTasksOptions;
  private readonly tasks = new Map<string, Running>();
  private next = 1;
  private closeMcp: (() => Promise<void>) | null = null;
  private ready: Promise<void>;
  private readonly checks: NodeJS.Timeout;
  private checking = false;

  constructor(opts: BackgroundTasksOptions) {
    this.opts = opts;
    this.ready = rm(opts.logDir, { recursive: true, force: true }).then(() =>
      mkdir(opts.logDir, { recursive: true, mode: 0o700 }).then(() => undefined),
    );
    this.checks = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.checks.unref();
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()]
      .map((r) => r.task)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  /** Where a task's output goes, or null for no such task. */
  logPath(id: string): string | null {
    return this.tasks.get(id)?.log ?? null;
  }

  async start(input: { command: string; name?: string; cwd?: string }): Promise<BackgroundTask> {
    await this.ready;
    const id = `task-${this.next++}`;
    const cwd = input.cwd
      ? isAbsolute(input.cwd)
        ? input.cwd
        : resolve(this.opts.workdir, input.cwd)
      : this.opts.workdir;
    const log = join(this.opts.logDir, `${id}.log`);
    const fd = openSync(log, "a");
    const task: BackgroundTask = {
      id,
      name: input.name?.trim() || input.command.slice(0, 60),
      command: input.command,
      cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    const running: Running = { task, child: null, log };
    this.tasks.set(id, running);
    try {
      // Its own process group, so stopping it stops whatever it started too.
      const child = spawn(SHELL.file, [...SHELL.args, input.command], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", fd, fd],
        env: process.env,
        windowsHide: true,
      });
      running.child = child;
      child.on("error", (err) => {
        running.leaderCode = null;
        this.ended(running);
        void open(log, "a").then(async (h) => {
          await h.write(`\n[couldn't start: ${err.message}]\n`);
          await h.close();
        });
      });
      // It's over when its whole group is, not just the command: a script that
      // starts a server with `&` and returns leaves the server running.
      child.on("exit", (code) => {
        running.leaderCode = code;
        if (!groupAlive(child.pid)) this.ended(running);
      });
    } finally {
      closeSync(fd);
    }
    this.prune();
    this.changed();
    return task;
  }

  /** The end of a task's output, `lines` lines of it. */
  async output(id: string, lines = 100): Promise<string> {
    const running = this.tasks.get(id);
    if (!running) throw new Error(`No task ${id}`);
    const handle = await open(running.log, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return lastLines(buffer.toString("utf8"), lines);
    } finally {
      await handle.close();
    }
  }

  /** Stops a task: SIGTERM to its group, then SIGKILL if it's still there after a grace. */
  stop(id: string): BackgroundTask {
    const running = this.tasks.get(id);
    if (!running) throw new Error(`No task ${id}`);
    const pid = running.child?.pid;
    if (running.task.status === "running" && pid) {
      signalGroup(pid, "SIGTERM");
      setTimeout(() => {
        if (running.task.status === "running") signalGroup(pid, "SIGKILL");
      }, this.opts.stopGraceMs ?? STOP_GRACE_MS).unref();
    }
    return running.task;
  }

  /**
   * Stops everything, for when the runner shuts down: SIGTERM first, so a
   * server can save what it has, then SIGKILL for whatever's left after
   * `graceMs`.
   */
  async stopAll(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    const groups = [...this.tasks.values()]
      .filter((r) => r.task.status === "running" && r.child?.pid)
      .map((r) => r.child?.pid as number);
    for (const pid of groups) signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (groups.some(groupAlive) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 100));
    for (const pid of groups) if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  }

  private ended(running: Running): void {
    if (running.task.status === "exited") return;
    running.task = {
      ...running.task,
      status: "exited",
      exitCode: running.leaderCode ?? null,
      endedAt: new Date().toISOString(),
    };
    this.changed();
  }

  /**
   * Once a second: ends tasks whose command exited and whose group has now
   * gone too, and cuts back logs that have grown too long.
   */
  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const running of this.tasks.values()) {
        if (running.task.status !== "running") continue;
        if (running.leaderCode !== undefined && !groupAlive(running.child?.pid))
          this.ended(running);
        await this.trimLog(running.log).catch(() => undefined);
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * Keeps a log to its last KEEP_LOG_BYTES once it's past MAX_LOG_BYTES. The
   * task appends to it as it goes, so a line or two written while it's cut
   * back may land before the kept part rather than after it.
   */
  async trimLog(log: string): Promise<void> {
    const max = this.opts.maxLogBytes ?? MAX_LOG_BYTES;
    const keep = this.opts.keepLogBytes ?? KEEP_LOG_BYTES;
    const handle = await open(log, "r+");
    try {
      const { size } = await handle.stat();
      if (size <= max) return;
      const tail = Buffer.alloc(keep);
      await handle.read(tail, 0, keep, size - keep);
      // From the first whole line.
      const start = tail.indexOf(10) + 1;
      await handle.truncate(0);
      await appendFile(
        log,
        Buffer.concat([Buffer.from("[earlier output trimmed]\n"), tail.subarray(start)]),
      );
    } finally {
      await handle.close();
    }
  }

  private prune(): void {
    const finished = this.list().filter((t) => t.status === "exited");
    for (const task of finished.slice(KEEP_FINISHED)) {
      const log = this.tasks.get(task.id)?.log;
      this.tasks.delete(task.id);
      if (log) void rm(log, { force: true });
    }
  }

  private changed(): void {
    this.opts.onChange?.(this.list());
  }

  /** A local MCP server with the `task_*` tools, for the harness to call. */
  async startMcp(): Promise<McpServerSpec> {
    const served = await serveMcp("tasks", (server) => {
      server.registerTool(
        "task_start",
        {
          description:
            "Start a long-running command in the background (a dev server, a game server, a watcher, a long build) that keeps running after this call returns and after your turn ends. Use this rather than `&`, `nohup` or a shell tool's own background mode for anything that should stay up. Its output goes to a log you read with `task_output`; the user can watch it and stop it too. Tasks end if your container stops or restarts, so start them again when you wake up if they should still be running.",
          inputSchema: {
            command: z.string().min(1).describe(`The shell command to run, as in ${SHELL.name}`),
            name: z.string().max(80).optional().describe("A short name for it, like 'minecraft'"),
            cwd: z
              .string()
              .optional()
              .describe("Where to run it, absolute or relative to your working directory"),
          },
        },
        ({ command, name, cwd }) =>
          toolReply(async () => {
            const task = await this.start({ command, name, cwd });
            return `Started ${task.id} (${task.name}). Check on it with task_output.`;
          }),
      );
      server.registerTool(
        "task_list",
        {
          description: "List your background tasks, running and recently finished.",
          inputSchema: {},
        },
        () =>
          toolReply(() => {
            const tasks = this.list();
            if (tasks.length === 0) return "No background tasks.";
            return tasks
              .map(
                (t) =>
                  `${t.id} (${t.name}): ${t.status === "running" ? "running" : `exited${t.exitCode === null ? "" : ` with ${t.exitCode}`}`} since ${t.endedAt ?? t.startedAt}\n  $ ${t.command}\n  in ${t.cwd}`,
              )
              .join("\n");
          }),
      );
      server.registerTool(
        "task_output",
        {
          description: "Read the end of a background task's output.",
          inputSchema: {
            id: z.string().describe("The task's id, from task_start or task_list"),
            lines: z.int().min(1).max(2000).optional().describe("How many lines; 100 by default"),
          },
        },
        ({ id, lines }) =>
          toolReply(async () => {
            const output = await this.output(id, lines ?? 100);
            const task = this.tasks.get(id)?.task;
            const state =
              task?.status === "exited"
                ? `[${id} exited${task.exitCode === null ? "" : ` with ${task.exitCode}`}]`
                : `[${id} is running]`;
            return output ? `${output}\n${state}` : `(no output yet)\n${state}`;
          }),
      );
      server.registerTool(
        "task_stop",
        {
          description:
            "Stop a background task and everything it started. It gets a few seconds to exit cleanly before it's killed.",
          inputSchema: { id: z.string().describe("The task's id") },
        },
        ({ id }) =>
          toolReply(() => {
            const task = this.stop(id);
            return task.status === "running" ? `Stopping ${id}.` : `${id} had already exited.`;
          }),
      );
    });
    this.closeMcp = served.close;
    return served.spec;
  }

  async close(): Promise<void> {
    clearInterval(this.checks);
    await this.stopAll();
    await this.closeMcp?.();
  }
}

/**
 * What a task runs in: a login bash, or on Windows PowerShell, which has no
 * process groups, so a task there is over when its command is, and
 * stopping one ends its tree with taskkill.
 */
const SHELL =
  process.platform === "win32"
    ? {
        file: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-Command"],
        name: "PowerShell -Command",
      }
    : { file: "bash", args: ["-lc"], name: "bash -lc" };

/** Whether anything in a task's process group is still running. */
function groupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No signals but the end: gently first, which a windowed app may answer.
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
      () => {},
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
