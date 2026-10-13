import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TurnWriter } from "@nibblet/harness";
import type { ThreadItem } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeMapper } from "./mapper.ts";

function run(messages: SDKMessage[]) {
  const emitted: ThreadItem[] = [];
  const out = new TurnWriter("t1", (item) => emitted.push(item), 0);
  const mapper = new ClaudeMapper(out);
  for (const m of messages) mapper.handle(m);
  out.finish();
  const latest = new Map<string, ThreadItem>();
  for (const item of emitted) latest.set(item.id, item);
  return { mapper, items: [...latest.values()] };
}

// Recorded shapes, trimmed to the fields the mapper reads. JSON.parse keeps
// the fixtures honest about being wire data rather than hand-built objects.
const fixture = (raw: object): SDKMessage => JSON.parse(JSON.stringify(raw));

const base = { session_id: "sess-1", uuid: "u", parent_tool_use_id: null };

describe("ClaudeMapper", () => {
  it("streams text, then opens and closes a tool call", () => {
    const { mapper, items } = run([
      fixture({
        ...base,
        type: "stream_event",
        event: { type: "message_start", message: { id: "m1" } },
      }),
      fixture({
        ...base,
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Hmm" },
        },
      }),
      fixture({ ...base, type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
      fixture({
        ...base,
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hel" },
        },
      }),
      fixture({
        ...base,
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } },
      }),
      fixture({ ...base, type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
      fixture({
        ...base,
        type: "assistant",
        message: {
          id: "m1",
          content: [
            { type: "text", text: "Hello" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "mcp__nibblet__memory_search",
              input: { query: "cats" },
            },
          ],
        },
      }),
      fixture({
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "text", text: "found" }],
            },
          ],
        },
      }),
      fixture({
        ...base,
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({ id: "m1:0", type: "reasoning", text: "Hmm", streaming: false }),
      expect.objectContaining({
        id: "m1:1",
        type: "assistant_message",
        text: "Hello",
        streaming: false,
      }),
      expect.objectContaining({
        id: "tool-1",
        type: "tool_call",
        server: "nibblet",
        name: "memory_search",
        input: { query: "cats" },
        output: "found",
        status: "done",
      }),
    ]);
    expect(mapper.state).toEqual({
      sessionId: "sess-1",
      usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 },
      error: null,
      finished: true,
    });
  });

  it("uses the complete message when nothing streamed, and reports errors", () => {
    const { mapper, items } = run([
      fixture({
        ...base,
        type: "assistant",
        message: { id: "m2", content: [{ type: "text", text: "Hi" }] },
      }),
      fixture({
        ...base,
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);
    expect(items).toEqual([expect.objectContaining({ id: "m2:0", text: "Hi" })]);
    expect(mapper.state.error).toBe("error_max_turns");
  });

  it("ignores sub-agent frames", () => {
    const { items } = run([
      fixture({
        ...base,
        parent_tool_use_id: "task-1",
        type: "assistant",
        message: { id: "m3", content: [{ type: "text", text: "inner" }] },
      }),
    ]);
    expect(items).toEqual([]);
  });
});
