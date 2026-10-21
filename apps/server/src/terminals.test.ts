import type { ServerToRunner } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { TerminalHub } from "./terminals.ts";

function hub(running: string[]) {
  const sent: { nibbletId: string; message: ServerToRunner }[] = [];
  const terminals = new TerminalHub((nibbletId, message) => {
    if (!running.includes(nibbletId)) return false;
    sent.push({ nibbletId, message });
    return true;
  });
  const events: string[] = [];
  const sink = {
    output: (data: string) => events.push(`out:${data}`),
    exit: (code: number | null) => events.push(`exit:${code}`),
  };
  return { terminals, sent, events, sink };
}

describe("TerminalHub", () => {
  it("opens a terminal on the nibblet's runner and passes its output back", () => {
    const { terminals, sent, events, sink } = hub(["nib_a"]);
    const id = terminals.openTerminal("nib_a", { cols: 90, rows: 20 }, null, sink);
    expect(id).not.toBeNull();
    expect(sent[0]?.message).toEqual({
      type: "terminal_open",
      terminalId: id,
      cols: 90,
      rows: 20,
      taskId: null,
    });
    terminals.input(id!, "ls\r");
    expect(sent[1]?.message).toEqual({ type: "terminal_input", terminalId: id, data: "ls\r" });
    terminals.fromRunner("nib_a", { type: "terminal_output", terminalId: id!, data: "hi" });
    terminals.fromRunner("nib_a", { type: "terminal_exit", terminalId: id!, code: 0 });
    expect(events).toEqual(["out:hi", "exit:0"]);
  });

  it("refuses a nibblet that isn't running", () => {
    const { terminals, sink } = hub([]);
    expect(terminals.openTerminal("nib_a", { cols: 80, rows: 24 }, null, sink)).toBeNull();
  });

  it("won't let one runner write to another's terminal", () => {
    const { terminals, events, sink } = hub(["nib_a", "nib_b"]);
    const id = terminals.openTerminal("nib_a", { cols: 80, rows: 24 }, null, sink)!;
    terminals.fromRunner("nib_b", { type: "terminal_output", terminalId: id, data: "spoof" });
    terminals.fromRunner("nib_b", { type: "terminal_exit", terminalId: id, code: 0 });
    expect(events).toEqual([]);
  });

  it("passes the browser's acks on to the runner", () => {
    const { terminals, sent, sink } = hub(["nib_a"]);
    const id = terminals.openTerminal("nib_a", { cols: 80, rows: 24 }, null, sink) ?? "";
    terminals.ack(id, 4096);
    expect(sent.at(-1)?.message).toEqual({ type: "terminal_ack", terminalId: id, chars: 4096 });
  });

  it("ends its terminals and forgets its tasks when the runner goes", () => {
    const { terminals, events, sink } = hub(["nib_a"]);
    const told: [string, number][] = [];
    terminals.onTasks = (id, tasks) => told.push([id, tasks.length]);
    terminals.openTerminal("nib_a", { cols: 80, rows: 24 }, null, sink);
    terminals.fromRunner("nib_a", {
      type: "tasks",
      tasks: [
        {
          id: "task-1",
          name: "mc",
          command: "java -jar server.jar",
          cwd: "/home/nibblet/work",
          status: "running",
          exitCode: null,
          startedAt: "2026-10-15T00:00:00.000Z",
          endedAt: null,
        },
      ],
    });
    expect(terminals.tasksOf("nib_a")).toHaveLength(1);
    expect(told).toEqual([["nib_a", 1]]);
    terminals.runnerGone("nib_a");
    expect(events).toEqual(["exit:null"]);
    expect(terminals.tasksOf("nib_a")).toEqual([]);
    // The UI hears both, so it needn't ask.
    expect(told).toEqual([
      ["nib_a", 1],
      ["nib_a", 0],
    ]);
  });

  it("keeps each runner's apps, asks for them again, and forgets them when it goes", () => {
    const { terminals, sent } = hub(["nib_a"]);
    const changes: [string, number][] = [];
    terminals.onApps = (id, apps) => changes.push([id, apps.length]);
    const app = {
      id: "foot",
      name: "Foot",
      comment: null,
      icon: null,
      command: "foot",
      args: [],
      categories: [],
    };
    terminals.fromRunner("nib_a", { type: "apps", apps: [app] });
    expect(terminals.appsOf("nib_a")).toEqual([app]);
    expect(terminals.scanApps("nib_a")).toBe(true);
    expect(sent.at(-1)?.message).toEqual({ type: "apps_scan" });
    expect(terminals.scanApps("nib_b")).toBe(false);
    terminals.runnerGone("nib_a");
    expect(terminals.appsOf("nib_a")).toEqual([]);
    expect(changes).toEqual([
      ["nib_a", 1],
      ["nib_a", 0],
    ]);
  });
});
