import { describe, expect, it } from "vitest";
import { describeTask, parseTerminalEvent, terminalPath } from "./terminal.ts";

describe("terminalPath", () => {
  it("asks for a shell, or a task's output", () => {
    expect(terminalPath("nib 1", { cols: 80, rows: 24 }, null)).toBe(
      "/api/nibblets/nib%201/terminal?cols=80&rows=24",
    );
    expect(terminalPath("nib_1", { cols: 80, rows: 24 }, "task-2")).toBe(
      "/api/nibblets/nib_1/terminal?cols=80&rows=24&task=task-2",
    );
  });
});

describe("parseTerminalEvent", () => {
  it("reads what the server sends and ignores anything else", () => {
    expect(parseTerminalEvent('{"type":"output","data":"hi"}')).toEqual({
      type: "output",
      data: "hi",
    });
    expect(parseTerminalEvent('{"type":"exit","code":null}')).toEqual({ type: "exit", code: null });
    expect(parseTerminalEvent("not json")).toBeNull();
    expect(parseTerminalEvent('{"type":"other"}')).toBeNull();
  });
});

describe("describeTask", () => {
  const task = {
    id: "task-1",
    name: "mc",
    command: "java -jar server.jar",
    cwd: "/home/nibblet/work",
    startedAt: "2026-10-15T00:00:00.000Z",
  };
  it("says how it stands", () => {
    expect(describeTask({ ...task, status: "running", exitCode: null, endedAt: null })).toBe(
      "running",
    );
    expect(describeTask({ ...task, status: "exited", exitCode: 1, endedAt: task.startedAt })).toBe(
      "exited with 1",
    );
    expect(
      describeTask({ ...task, status: "exited", exitCode: null, endedAt: task.startedAt }),
    ).toBe("stopped");
  });
});
