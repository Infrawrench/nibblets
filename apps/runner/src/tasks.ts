import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerSpec } from "@nibblet/harness";
import type { BackgroundTask } from "@nibblet/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/** Finished tasks kept in the list, newest first, before the oldest are forgotten. */
const KEEP_FINISHED = 20;
/** How long a stopped task gets to exit before it's killed. */
const STOP_GRACE_MS = 10_000;
/** How much of a log's end `output` reads, at most. */
const TAIL_BYTES = 256 * 1024;

export interface BackgroundTasksOptions {
  workdir: string;
  /** Where the logs go; emptied on start, since the tasks they belong to are gone. */
  logDir: string;
  /** Called with the whole list whenever it changes. */
  onChange?: (tasks: BackgroundTask[]) => void;
  /** Overrides STOP_GRACE_MS, for tests. */
  stopGraceMs?: number;
}

interface Running {
  task: BackgroundTask;
  child: ChildProcess | null;
  log: string;
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
  private http: HttpServer | null = null;
  private ready: Promise<void>;

  constructor(opts: BackgroundTasksOptions) {
    this.opts = opts;
    this.ready = rm(opts.logDir, { recursive: true, force: true }).then(() =>
      mkdir(opts.logDir, { recursive: true, mode: 0o700 }).then(() => undefined),
    );
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
      const child = spawn("bash", ["-lc", input.command], {
        cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      });
      running.child = child;
      child.on("error", (err) => {
        this.ended(running, null);
        void open(log, "a").then(async (h) => {
          await h.write(`\n[couldn't start: ${err.message}]\n`);
          await h.close();
        });
      });
      child.on("exit", (code) => this.ended(running, code));
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

  /** Stops everything, for when the runner shuts down. */
  stopAll(): void {
    for (const running of this.tasks.values()) {
      const pid = running.child?.pid;
      if (running.task.status === "running" && pid) signalGroup(pid, "SIGKILL");
    }
  }

  private ended(running: Running, code: number | null): void {
    if (running.task.status === "exited") return;
    running.task = {
      ...running.task,
      status: "exited",
      exitCode: code,
      endedAt: new Date().toISOString(),
    };
    this.changed();
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
    const reply = async (work: () => Promise<string> | string) => {
      try {
        return { content: [{ type: "text" as const, text: await work() }] };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    };
    const http = createServer((req, res) => {
      const server = new McpServer({ name: "tasks", version: "0.1.0" });
      server.registerTool(
        "task_start",
        {
          description:
            "Start a long-running command in the background (a dev server, a game server, a watcher, a long build) that keeps running after this call returns and after your turn ends. Use this rather than `&`, `nohup` or a shell tool's own background mode for anything that should stay up. Its output goes to a log you read with `task_output`; the user can watch it and stop it too. Tasks end if your container stops or restarts, so start them again when you wake up if they should still be running.",
          inputSchema: {
            command: z.string().min(1).describe("The shell command to run, as in bash -lc"),
            name: z.string().max(80).optional().describe("A short name for it, like 'minecraft'"),
            cwd: z
              .string()
              .optional()
              .describe("Where to run it, absolute or relative to your working directory"),
          },
        },
        ({ command, name, cwd }) =>
          reply(async () => {
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
          reply(() => {
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
          reply(async () => {
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
          reply(() => {
            const task = this.stop(id);
            return task.status === "running" ? `Stopping ${id}.` : `${id} had already exited.`;
          }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    this.http = http;
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", () => done()));
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {} };
  }

  async close(): Promise<void> {
    this.stopAll();
    await new Promise<void>((done) => (this.http ? this.http.close(() => done()) : done()));
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
