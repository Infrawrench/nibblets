import { TurnWriter } from "@nibblet/harness";
import type { ThreadItem } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { KimiLine } from "@nibblet/protocol";
import { failureFrom } from "./index.ts";
import { KimiMapper, parseArguments } from "./mapper.ts";

/** Lines in the shape `kimi -p --output-format stream-json` writes to stdout. */
const lines = [
  { role: "meta", type: "system.version", version: "2.2.0" },
  { role: "assistant", content: "Reading the file." },
  {
    role: "assistant",
    tool_calls: [
      { type: "function", id: "call_1", function: { name: "Read", arguments: '{"path":"a.ts"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
  { role: "assistant", content: "It exports `a`." },
  { role: "meta", type: "session.resume_hint", session_id: "01HZ", content: "resume" },
];

function run(input: readonly unknown[]) {
  const emitted: ThreadItem[] = [];
  const out = new TurnWriter("t1", (item) => emitted.push(item), 0);
  const mapper = new KimiMapper(out);
  for (const line of input) {
    const known = KimiLine.safeParse(line);
    if (known.success) mapper.handle(known.data);
  }
  mapper.finish();
  out.finish();
  const latest = new Map<string, ThreadItem>();
  for (const item of emitted) latest.set(item.id, item);
  return { mapper, items: [...latest.values()] };
}

describe("KimiMapper", () => {
  it("turns each assistant message into its own item", () => {
    const { items } = run(lines);
    const messages = items.filter((i) => i.type === "assistant_message");
    expect(messages.map((m) => (m.type === "assistant_message" ? m.text : ""))).toEqual([
      "Reading the file.",
      "It exports `a`.",
    ]);
    expect(messages.every((m) => m.type === "assistant_message" && !m.streaming)).toBe(true);
  });

  it("opens a tool call on the assistant message and closes it on the tool message", () => {
    const { items } = run(lines);
    const call = items.find((i) => i.type === "tool_call");
    expect(call).toMatchObject({
      type: "tool_call",
      name: "Read",
      status: "done",
      output: "export const a = 1;",
      input: { path: "a.ts" },
    });
  });

  it("takes the session id from the resume hint so the next turn can resume", () => {
    const { mapper } = run(lines);
    expect(mapper.state.sessionId).toBe("01HZ");
    expect(mapper.state.version).toBe("2.2.0");
    expect(mapper.state.error).toBeNull();
  });

  it("ignores lines it doesn't know, and reports a retry as a notice", () => {
    const { mapper, items } = run([
      { role: "meta", type: "system.version", version: "2.2.0" },
      { role: "something-else", text: "future" },
      "not json at all",
      {
        role: "meta",
        type: "turn.step.retrying",
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 3,
        delay_ms: 500,
        error_name: "RateLimitError",
        error_message: "429 from the provider",
      },
    ]);
    expect(mapper.state.error).toBe("429 from the provider");
    expect(items).toContainEqual(
      expect.objectContaining({ type: "notice", level: "warning", text: "429 from the provider" }),
    );
  });

  it("closes a tool call as interrupted when its result never arrives", () => {
    const { items } = run([
      {
        role: "assistant",
        tool_calls: [{ type: "function", id: "c1", function: { name: "Bash", arguments: "{}" } }],
      },
    ]);
    expect(items.find((i) => i.type === "tool_call")).toMatchObject({
      status: "error",
      output: "Interrupted",
    });
  });
});

describe("parseArguments", () => {
  it("parses the JSON string the CLI sends", () => {
    expect(parseArguments('{"path":"a.ts","limit":10}')).toEqual({ path: "a.ts", limit: 10 });
  });

  it("keeps anything unparseable as text rather than losing it", () => {
    expect(parseArguments("not json")).toBe("not json");
    expect(parseArguments("")).toEqual({});
    expect(parseArguments(undefined)).toEqual({});
  });
});

describe("failureFrom", () => {
  // Stderr captured from a real `kimi -p` run with no valid credential.
  const stderr = [
    "Warning: this folder is not trusted; skipped 1 project-level MCP server.",
    "error: failed to run prompt: provider managed:kimi-code has no credential configured",
    "See log: /home/nibblet/work/.kimi-code/logs/kimi-code.log",
  ].join("\n");

  it("takes the reason, not the log pointer that follows it", () => {
    expect(failureFrom(stderr, 1)).toBe(
      "failed to run prompt: provider managed:kimi-code has no credential configured",
    );
  });

  it("falls back to the last line, then to the exit code", () => {
    expect(failureFrom("something broke\nSee log: /tmp/x.log", 1)).toBe("See log: /tmp/x.log");
    expect(failureFrom("", 3)).toBe("kimi exited with code 3");
  });
});
