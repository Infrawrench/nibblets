import { defaultHamsterLook, type Nibblet } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { isQuiet, recap, systemPrompt } from "./context.ts";
import { withinActiveHours } from "./scheduler.ts";

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
  heartbeat: { enabled: true, everyMinutes: 30, activeHours: null, prompt: null },
  browser: true,
  hostTools: [],
  cliCredentials: [],
  mcpServers: [],
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
