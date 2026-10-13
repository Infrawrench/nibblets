import type { Event } from "@opencode-ai/sdk";
import { TurnWriter } from "@nibblet/harness";
import type { ThreadItem } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { OpencodeMapper } from "./mapper.ts";

const fixture = (raw: object): Event => JSON.parse(JSON.stringify(raw));
const part = (p: object, delta?: string) =>
  fixture({ type: "message.part.updated", properties: { part: { sessionID: "s1", ...p }, delta } });

function run(events: Event[]) {
  const emitted: ThreadItem[] = [];
  const out = new TurnWriter("t1", (item) => emitted.push(item), 0);
  const mapper = new OpencodeMapper(out, "s1");
  for (const e of events) mapper.handle(e);
  out.finish();
  const latest = new Map<string, ThreadItem>();
  for (const item of emitted) latest.set(item.id, item);
  return { mapper, items: [...latest.values()] };
}

describe("OpencodeMapper", () => {
  it("skips the user's parts and maps text and tools", () => {
    const { mapper, items } = run([
      fixture({
        type: "message.updated",
        properties: { info: { id: "mu", sessionID: "s1", role: "user" } },
      }),
      part({ id: "pu", messageID: "mu", type: "text", text: "question" }),
      part({ id: "p1", messageID: "ma", type: "text", text: "An", time: { start: 1 } }, "An"),
      part({ id: "p1", messageID: "ma", type: "text", text: "Answer", time: { start: 1 } }, "swer"),
      part({
        id: "p1",
        messageID: "ma",
        type: "text",
        text: "Answer.",
        time: { start: 1, end: 2 },
      }),
      part({
        id: "pt",
        messageID: "ma",
        type: "tool",
        callID: "call-1",
        tool: "nibblet_memory_search",
        state: { status: "running", input: { query: "x" }, time: { start: 1 } },
      }),
      part({
        id: "pt",
        messageID: "ma",
        type: "tool",
        callID: "call-1",
        tool: "nibblet_memory_search",
        state: {
          status: "completed",
          input: { query: "x" },
          output: "nothing",
          title: "",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }),
      fixture({ type: "session.idle", properties: { sessionID: "s1" } }),
      part({ id: "other", messageID: "mz", type: "text", text: "elsewhere", sessionID: "s2" }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        id: "p1",
        type: "assistant_message",
        text: "Answer.",
        streaming: false,
      }),
      expect.objectContaining({
        id: "call-1",
        name: "nibblet_memory_search",
        output: "nothing",
        status: "done",
      }),
    ]);
    expect(mapper.idle).toBe(true);
    expect(mapper.error).toBeNull();
  });

  it("records session errors", () => {
    const { mapper } = run([
      fixture({
        type: "session.error",
        properties: { sessionID: "s1", error: { name: "APIError", data: { message: "401" } } },
      }),
    ]);
    expect(mapper.error).toBe("401");
  });
});
