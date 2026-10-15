import type { BackgroundTask, RunnerToServer } from "@nibblet/protocol";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
});
