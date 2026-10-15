import type { ThreadEvent } from "@openai/codex-sdk";
import { TurnWriter } from "@nibblet/harness";
import type { ThreadItem } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { placeholderAuth } from "./index.ts";
import { CodexMapper } from "./mapper.ts";

function run(events: ThreadEvent[]) {
  const emitted: ThreadItem[] = [];
  const out = new TurnWriter("t1", (item) => emitted.push(item), 0);
  const mapper = new CodexMapper(out);
  for (const e of events) mapper.handle(e);
  out.finish();
  const latest = new Map<string, ThreadItem>();
  for (const item of emitted) latest.set(item.id, item);
  return { mapper, items: [...latest.values()] };
}

describe("CodexMapper", () => {
  it("maps messages, commands and MCP calls", () => {
    const { mapper, items } = run([
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "r1", type: "reasoning", text: "Plan" } },
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Plan it" } },
      {
        type: "item.started",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "a\nb",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.started",
        item: {
          id: "x1",
          type: "mcp_tool_call",
          server: "nibblet",
          tool: "memory_save",
          arguments: { content: "hi" },
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "x1",
          type: "mcp_tool_call",
          server: "nibblet",
          tool: "memory_save",
          arguments: { content: "hi" },
          result: { content: [{ type: "text", text: "saved" }], structured_content: null },
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Done" } },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 50,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: 7,
          reasoning_output_tokens: 3,
        },
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        id: "t1:r1",
        type: "reasoning",
        text: "Plan it",
        streaming: false,
      }),
      expect.objectContaining({
        id: "t1:c1",
        name: "shell",
        input: { command: "ls" },
        output: "a\nb\n(exit 0)",
        status: "done",
      }),
      expect.objectContaining({
        id: "t1:x1",
        server: "nibblet",
        name: "memory_save",
        output: "saved",
        status: "done",
      }),
      expect.objectContaining({ id: "t1:a1", type: "assistant_message", text: "Done" }),
    ]);
    expect(mapper.state).toEqual({
      threadId: "th-1",
      usage: { inputTokens: 50, outputTokens: 7, cachedInputTokens: 20 },
      error: null,
      finished: true,
    });
  });

  it("marks failed commands and turns", () => {
    const { mapper, items } = run([
      {
        type: "item.completed",
        item: {
          id: "c2",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
          status: "failed",
        },
      },
      { type: "turn.failed", error: { message: "usage limit" } },
    ]);
    expect(items).toEqual([expect.objectContaining({ id: "t1:c2", status: "error" })]);
    expect(mapper.state.error).toBe("usage limit");
  });

  it("reads an MCP call with a null error as done, and one with an error as failed", () => {
    // What `codex exec --json` writes: the absent side is null, not left out.
    const call = (id: string, rest: object) =>
      JSON.parse(
        JSON.stringify({
          type: "item.completed",
          item: {
            id,
            type: "mcp_tool_call",
            server: "computer",
            tool: "press_key",
            arguments: {},
            ...rest,
          },
        }),
      ) as ThreadEvent;
    const { items } = run([
      call("ok", {
        result: { content: [{ type: "text", text: "pressed" }], structured_content: null },
        error: null,
        status: "completed",
      }),
      call("bad", { result: null, error: { message: "no session" }, status: "failed" }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ id: "t1:ok", output: "pressed", status: "done" }),
      expect.objectContaining({ id: "t1:bad", output: "no session", status: "error" }),
    ]);
  });
});

describe("placeholderAuth", () => {
  it("is a ChatGPT login whose tokens are the proxy key", () => {
    const auth = placeholderAuth("secret", new Date("2026-10-13T00:00:00Z"));
    expect(auth.auth_mode).toBe("chatgpt");
    expect(auth.tokens.refresh_token).toBe("secret");
    expect(auth.tokens.access_token).toBe(auth.tokens.id_token);
    const payload = auth.tokens.id_token.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe("nibblet");
    expect(claims.nibblet_key).toBe("secret");
    expect(claims.exp).toBeGreaterThan(Date.parse("2030-01-01") / 1000);
  });
});
