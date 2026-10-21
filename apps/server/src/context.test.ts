import { defaultHamsterLook, type ActiveHours, type Nibblet } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { heartbeatInput, isQuiet, mayBeQuiet, recap, systemPrompt } from "./context.ts";
import { dueHeartbeat, withinActiveHours } from "./scheduler.ts";

const nibblet: Nibblet = {
  id: "nib_1",
  name: "Pip",
  look: defaultHamsterLook,
  harness: "claude",
  model: "claude-opus-5-5",
  effort: "medium",
  instructions: "Look after the deploys.",
  parentId: null,
  status: "idle",
  statusDetail: null,
  resources: { cpus: null, memoryMb: null },
  monthlyBudgetUsd: null,
  snapshotPolicy: { everyMinutes: 1440, keep: 7 },
  heartbeats: [
    {
      name: "inbox",
      everyMinutes: 15,
      activeHours: null,
      checklist: "Anything urgent?",
      lastRunAt: null,
    },
  ],
  browser: true,
  hostTools: [],
  cliCredentials: [],
  mcpServers: [],
  toolApprovals: [],
  tailscale: null,
  tailnetNode: null,
  statusText: "Watching the deploy",
  statusEmoji: null,
  statusUpdatedAt: null,
  awaitingApproval: false,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  lastActivityAt: null,
};

describe("isQuiet", () => {
  it("only applies to turns nobody asked for", () => {
    expect(isQuiet("heartbeat", " NO_REPLY ")).toBe(true);
    expect(isQuiet("schedule", "Checked everything. NO_REPLY")).toBe(true);
    expect(isQuiet("user", "NO_REPLY")).toBe(false);
    expect(isQuiet("heartbeat", "The deploy failed!")).toBe(false);
  });

  it("applies to a sub-agent's result and to carrying on after a restart", () => {
    expect(isQuiet("subagent", "NO_REPLY")).toBe(true);
    expect(isQuiet("system", "NO_REPLY")).toBe(true);
    expect(isQuiet("subagent", "5 of 8 mockups are done.")).toBe(false);
  });
});

describe("mayBeQuiet", () => {
  it("holds back a reply that's still spelling out NO_REPLY", () => {
    expect(mayBeQuiet("subagent", "NO")).toBe(true);
    expect(mayBeQuiet("heartbeat", "NO_REP")).toBe(true);
    expect(mayBeQuiet("heartbeat", "NO_REPLY")).toBe(true);
    expect(mayBeQuiet("heartbeat", "Nothing urgent, but")).toBe(false);
    expect(mayBeQuiet("user", "NO")).toBe(false);
  });
});

describe("withinActiveHours", () => {
  const at = new Date("2026-10-13T12:30:00Z"); // 13:30 in London (BST)
  it("handles ordinary windows in the given timezone", () => {
    expect(withinActiveHours({ start: "09:00", end: "17:00", timezone: "Europe/London" }, at)).toBe(
      true,
    );
    expect(withinActiveHours({ start: "14:00", end: "17:00", timezone: "Europe/London" }, at)).toBe(
      false,
    );
  });
  it("handles windows that wrap past midnight", () => {
    expect(withinActiveHours({ start: "22:00", end: "06:00", timezone: "UTC" }, at)).toBe(false);
    expect(
      withinActiveHours(
        { start: "22:00", end: "06:00", timezone: "UTC" },
        new Date("2026-10-13T23:00:00Z"),
      ),
    ).toBe(true);
  });
  it("treats no window as always", () => {
    expect(withinActiveHours(null, at)).toBe(true);
  });
});

describe("systemPrompt", () => {
  it("includes instructions, memories, recap, and the browser rule", () => {
    const prompt = systemPrompt({
      nibblet,
      serverName: "home",
      memories: [
        {
          id: "mem_1",
          nibbletId: null,
          sharedBy: null,
          content: "Prefers tea",
          tags: [],
          createdAt: "",
          score: 0.9,
        },
      ],
      history: [
        {
          type: "user_message",
          id: "m1",
          turnId: "t1",
          createdAt: "",
          text: "Hello",
          source: "user",
        },
        {
          type: "assistant_message",
          id: "a1",
          turnId: "t1",
          createdAt: "",
          text: "Hi!",
          streaming: false,
        },
      ],
      parent: null,
      now: new Date("2026-10-13T12:00:00Z"),
    });
    expect(prompt).toContain("Look after the deploys.");
    expect(prompt).toContain("(mem_1, shared) Prefers tea");
    expect(prompt).toContain("[user] Hello");
    expect(prompt).toContain("[you] Hi!");
    expect(prompt).toContain("computer");
  });

  it("tells it about the desktop and its apps only when it has one", () => {
    const base = { nibblet, serverName: "home", memories: [], history: null, parent: null };
    const now = new Date("2026-10-13T12:00:00Z");
    expect(systemPrompt({ ...base, now })).not.toContain("app_launch");
    const prompt = systemPrompt({ ...base, now, desktop: true });
    expect(prompt).toContain("`app_list`");
    expect(prompt).toContain("`desktop` tools");
    expect(prompt).toContain("~/.local/share/applications");
  });

  it("tells it where it is on the tailnet, what's shared, and how to reach out", () => {
    const base = { nibblet, serverName: "home", memories: [], history: null, parent: null };
    const now = new Date("2026-10-13T12:00:00Z");
    expect(systemPrompt({ ...base, now })).not.toContain("## Tailscale");
    const prompt = systemPrompt({
      ...base,
      now,
      tailnet: {
        node: {
          state: "running",
          dnsName: "pip.tail1234.ts.net",
          ips: ["100.64.0.7"],
          tailnet: "example.com",
          detail: null,
        },
        ports: [3000, 8080],
      },
    });
    expect(prompt).toContain("## Tailscale");
    expect(prompt).toContain("http://pip.tail1234.ts.net:3000");
    expect(prompt).toContain("ports 3000, 8080");
    expect(prompt).toContain("127.0.0.1:1055");
  });

  it("skips streaming replies in recaps", () => {
    expect(
      recap([
        {
          type: "assistant_message",
          id: "a",
          turnId: null,
          createdAt: "",
          text: "partial",
          streaming: true,
        },
      ]),
    ).toBe("");
  });
});

describe("dueHeartbeat", () => {
  const created = new Date("2026-10-13T08:00:00Z");
  const now = new Date("2026-10-13T12:00:00Z");
  const beat = (
    name: string,
    everyMinutes: number,
    lastRunAt: string | null,
    hours: ActiveHours | null = null,
  ) => ({
    name,
    everyMinutes,
    activeHours: hours,
    checklist: "",
    lastRunAt,
  });

  it("picks the most overdue heartbeat that's due", () => {
    const due = dueHeartbeat(
      [
        beat("inbox", 15, "2026-10-13T11:50:00Z"),
        beat("deploys", 60, "2026-10-13T10:30:00Z"),
        beat("news", 30, "2026-10-13T11:00:00Z"),
      ],
      created,
      now,
    );
    expect(due?.name).toBe("deploys");
  });

  it("waits from creation when a heartbeat has never run", () => {
    expect(dueHeartbeat([beat("a", 600, null)], created, now)).toBeNull();
    expect(dueHeartbeat([beat("a", 60, null)], created, now)?.name).toBe("a");
  });

  it("respects each heartbeat's own active hours", () => {
    const hours = { start: "14:00", end: "18:00", timezone: "UTC" };
    expect(dueHeartbeat([beat("a", 5, null, hours)], created, now)).toBeNull();
  });
});

describe("heartbeatInput", () => {
  it("names the heartbeat and carries its checklist", () => {
    const text = heartbeatInput({
      name: "inbox",
      everyMinutes: 15,
      activeHours: null,
      checklist: "Anything urgent?",
      lastRunAt: null,
    });
    expect(text).toContain('"inbox" heartbeat');
    expect(text).toContain("Anything urgent?");
  });
});
