import type { ThreadEvent, ThreadItem as CodexItem } from "@openai/codex-sdk";
import type { TurnWriter } from "@nibblet/harness";
import { JsonValue, type Usage } from "@nibblet/protocol";

export interface CodexTurnState {
  threadId: string | null;
  usage: Usage | null;
  error: string | null;
  finished: boolean;
}

/**
 * Feeds Codex thread events into a `TurnWriter`. Codex sends whole items on
 * every event (started, updated, completed), so text items are set rather
 * than appended, and a tool is opened the first time any event names it.
 */
export class CodexMapper {
  readonly state: CodexTurnState = { threadId: null, usage: null, error: null, finished: false };
  private readonly out: TurnWriter;
  private readonly started = new Set<string>();

  constructor(out: TurnWriter) {
    this.out = out;
  }

  handle(event: ThreadEvent): void {
    switch (event.type) {
      case "thread.started":
        this.state.threadId = event.thread_id;
        return;
      case "item.started":
      case "item.updated":
        this.item(event.item, false);
        return;
      case "item.completed":
        this.item(event.item, true);
        return;
      case "turn.completed":
        this.state.finished = true;
        this.state.usage = {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
        };
        return;
      case "turn.failed":
        this.state.finished = true;
        this.state.error = event.error.message;
        return;
      case "error":
        this.state.error = event.message;
        return;
      default:
        return;
    }
  }

  private item(raw: CodexItem, completed: boolean): void {
    // Codex numbers items per turn (`item_0`, `item_1`, …), so they are
    // prefixed with the turn to stay unique across the thread.
    const item = { ...raw, id: `${this.out.turnId}:${raw.id}` };
    switch (item.type) {
      case "agent_message":
      case "reasoning": {
        const kind = item.type === "agent_message" ? "assistant_message" : "reasoning";
        this.out.set(item.id, kind, item.text);
        if (completed) this.out.done(item.id);
        return;
      }
      case "command_execution":
        this.start(item.id, "shell", { command: item.command });
        if (completed || item.status !== "in_progress") {
          const exit = item.exit_code === undefined ? "" : `\n(exit ${item.exit_code})`;
          this.out.toolEnd(
            item.id,
            `${item.aggregated_output}${exit}`,
            item.status === "failed" || (item.exit_code ?? 0) !== 0,
          );
        }
        return;
      case "mcp_tool_call":
        this.start(item.id, `mcp__${item.server}__${item.tool}`, toJson(item.arguments));
        if (completed || item.status !== "in_progress") {
          const output = item.error
            ? item.error.message
            : (item.result?.content ?? [])
                .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                .join("\n");
          // Codex writes `"error": null` on a call that worked, so it's the
          // status that says whether it failed, not whether the key is there.
          this.out.toolEnd(item.id, output, item.status === "failed" || item.error != null);
        }
        return;
      case "file_change": {
        const changes = item.changes.map((c) => ({ path: c.path, kind: c.kind }));
        this.start(item.id, "apply_patch", { changes });
        if (completed) {
          const summary = item.changes.map((c) => `${c.kind} ${c.path}`).join("\n");
          this.out.toolEnd(item.id, summary, item.status === "failed");
        }
        return;
      }
      case "web_search":
        this.start(item.id, "web_search", { query: item.query });
        if (completed) this.out.toolEnd(item.id, "", false);
        return;
      case "todo_list": {
        const list = item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
        // Re-opened on every update so the running list shows the latest state.
        this.out.toolStart(item.id, "todo_list", {
          items: item.items.map((t) => ({ text: t.text, completed: t.completed })),
        });
        this.started.add(item.id);
        if (completed) this.out.toolEnd(item.id, list, false);
        return;
      }
      case "error":
        this.out.notice("warning", item.message);
        return;
      default:
        return;
    }
  }

  private start(id: string, name: string, input: JsonValue): void {
    if (this.started.has(id)) return;
    this.started.add(id);
    this.out.toolStart(id, name, input);
  }
}

export function toJson(value: unknown): JsonValue {
  const parsed = JsonValue.safeParse(value);
  return parsed.success ? parsed.data : String(value);
}
