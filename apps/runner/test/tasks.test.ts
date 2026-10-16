import type { BackgroundTask, RunnerToServer } from "@nibblet/protocol";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BackgroundTasks, lastLines } from "../src/tasks.ts";
import { Terminals } from "../src/terminals.ts";

// Real, since `pwd` gives the real path (macOS keeps temp folders behind a link).
const work = realpathSync(mkdtempSync(join(tmpdir(), "runner-tasks-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("lastLines", () => {
  it("takes the end, ignoring a trailing newline", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines("a", 5)).toBe("a");
  });
});

describe("BackgroundTasks", () => {
  it("runs a command past the call that started it, logging its output", async () => {
    const seen: BackgroundTask[][] = [];
    const tasks = new BackgroundTasks({
      workdir: work,
      logDir: join(work, "logs"),
      onChange: (list) => seen.push(list),
    });
    const task = await tasks.start({ command: "echo one; echo two >&2; pwd", name: "hello" });
    expect(task).toMatchObject({ id: "task-1", name: "hello", status: "running", cwd: work });
    await until(() => tasks.list()[0]?.status === "exited");
    expect(tasks.list()[0]?.exitCode).toBe(0);
    expect(await tasks.output(task.id)).toBe(`one\ntwo\n${work}`);
    expect(await tasks.output(task.id, 1)).toBe(work);
    expect(seen.at(-1)?.[0]?.status).toBe("exited");
    await tasks.close();
  });

  it("stops a task and whatever it started", async () => {
    const tasks = new BackgroundTasks({ workdir: work, logDir: join(work, "logs2") });
    const task = await tasks.start({ command: "sleep 30 & sleep 30; wait" });
    await new Promise((r) => setTimeout(r, 200));
    tasks.stop(task.id);
    await until(() => tasks.list()[0]?.status === "exited");
    await expect(tasks.output("task-99")).rejects.toThrow("No task task-99");
    await tasks.close();
  });

  it("keeps running while what the command started does, and can still stop it", async () => {
    const tasks = new BackgroundTasks({ workdir: work, logDir: join(work, "logs3") });
    // Like a start script that backgrounds the server and returns.
    const task = await tasks.start({ command: "sleep 30 & echo started" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(tasks.list()[0]?.status).toBe("running");
    tasks.stop(task.id);
    await until(() => tasks.list()[0]?.status === "exited");
    expect(tasks.list()[0]?.exitCode).toBe(0);
    await tasks.close();
  });

  it("gives tasks SIGTERM and time to finish when shutting down", async () => {
    const tasks = new BackgroundTasks({ workdir: work, logDir: join(work, "logs4") });
    const marker = join(work, "saved");
    await tasks.start({
      command: `trap 'sleep 0.3; echo saved > ${marker}; exit 0' TERM; while true; do sleep 0.1; done`,
    });
    await new Promise((r) => setTimeout(r, 300));
    await tasks.stopAll(5000);
    expect(readFileSync(marker, "utf8")).toBe("saved\n");
    await tasks.close();
  });

  it("cuts a log back to its end once it grows too long", async () => {
    const tasks = new BackgroundTasks({
      workdir: work,
      logDir: join(work, "logs5"),
      maxLogBytes: 1000,
      keepLogBytes: 100,
    });
    const log = join(work, "big.log");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(log, lines);
    await tasks.trimLog(log);
    const text = readFileSync(log, "utf8");
    expect(text.startsWith("[earlier output trimmed]\nline ")).toBe(true);
    expect(text.endsWith("line 199\n")).toBe(true);
    expect(text.length).toBeLessThan(150);
    await tasks.close();
  });
});

describe("Terminals", () => {
  it("runs a command in a real terminal, sized as asked", async () => {
    const out: RunnerToServer[] = [];
    const terminals = new Terminals({
      workdir: work,
      send: (m) => out.push(m),
      taskLog: () => null,
      shell: ["sh", "-c", "stty size; test -t 0 && echo tty"],
    });
    terminals.handle({
      type: "terminal_open",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      taskId: null,
    });
    await until(() => out.some((m) => m.type === "terminal_exit"));
    const text = out.flatMap((m) => (m.type === "terminal_output" ? [m.data] : [])).join("");
    expect(text).toContain("30 100");
    expect(text).toContain("tty");
    expect(out.at(-1)).toEqual({ type: "terminal_exit", terminalId: "t1", code: 0 });
  });

  it("passes input through and says when a task has gone", async () => {
    const out: RunnerToServer[] = [];
    const terminals = new Terminals({
      workdir: work,
      send: (m) => out.push(m),
      taskLog: () => null,
      shell: ["sh", "-c", "read line; echo got:$line"],
    });
    terminals.handle({ type: "terminal_open", terminalId: "t2", cols: 80, rows: 24, taskId: null });
    terminals.handle({ type: "terminal_input", terminalId: "t2", data: "hi\r" });
    await until(() => out.some((m) => m.type === "terminal_exit"));
    const text = out.flatMap((m) => (m.type === "terminal_output" ? [m.data] : [])).join("");
    expect(text).toContain("got:hi");

    terminals.handle({ type: "terminal_open", terminalId: "t3", cols: 80, rows: 24, taskId: "x" });
    expect(out.at(-1)).toEqual({ type: "terminal_exit", terminalId: "t3", code: null });
  });

  it("ends when the shell exits, even with a background job holding the terminal", async () => {
    const out: RunnerToServer[] = [];
    const terminals = new Terminals({
      workdir: work,
      send: (m) => out.push(m),
      taskLog: () => null,
      shell: ["sh", "-c", "sleep 30 & echo bye"],
    });
    terminals.handle({ type: "terminal_open", terminalId: "t4", cols: 80, rows: 24, taskId: null });
    await until(() => out.some((m) => m.type === "terminal_exit"), 3000);
    expect(out.at(-1)).toEqual({ type: "terminal_exit", terminalId: "t4", code: 0 });
  });

  it("takes a big paste while the program is busy printing", async () => {
    const out: RunnerToServer[] = [];
    const terminals = new Terminals({
      workdir: work,
      send: (m) => out.push(m),
      taskLog: () => null,
      // Not reading its input while it writes a lot: a helper that stopped to
      // push the paste in would stop reading this output, and both would wait.
      shell: ["sh", "-c", "sleep 0.5; yes | head -c 2000000; echo; echo finished"],
    });
    terminals.handle({ type: "terminal_open", terminalId: "t5", cols: 80, rows: 24, taskId: null });
    terminals.handle({
      type: "terminal_input",
      terminalId: "t5",
      data: `${"x".repeat(99)}\n`.repeat(2000),
    });
    const text = () => out.flatMap((m) => (m.type === "terminal_output" ? [m.data] : [])).join("");
    // Drawn as it comes, as the browser would.
    let acked = 0;
    const ack = setInterval(() => {
      const total = text().length;
      terminals.handle({ type: "terminal_ack", terminalId: "t5", chars: total - acked });
      acked = total;
    }, 20);
    try {
      await until(() => out.some((m) => m.type === "terminal_exit"), 15_000);
    } finally {
      clearInterval(ack);
    }
    expect(text()).toContain("finished");
  }, 20_000);

  it("stops reading a flood until the browser catches up", async () => {
    const out: RunnerToServer[] = [];
    const terminals = new Terminals({
      workdir: work,
      send: (m) => out.push(m),
      taskLog: () => null,
      shell: ["sh", "-c", "yes"],
    });
    terminals.handle({ type: "terminal_open", terminalId: "t6", cols: 80, rows: 24, taskId: null });
    const sent = () =>
      out.flatMap((m) => (m.type === "terminal_output" ? [m.data] : [])).join("").length;
    await until(() => sent() > 512 * 1024);
    await new Promise((r) => setTimeout(r, 300));
    const held = sent();
    await new Promise((r) => setTimeout(r, 300));
    // Nothing acknowledged: it's stopped, not much past where it paused.
    expect(sent()).toBe(held);
    expect(held).toBeLessThan(1024 * 1024);
    terminals.handle({ type: "terminal_ack", terminalId: "t6", chars: held });
    await until(() => sent() > held);
    terminals.closeAll();
    await until(() => out.some((m) => m.type === "terminal_exit"), 8000);
  });
});
