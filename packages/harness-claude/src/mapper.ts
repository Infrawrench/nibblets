import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnWriter } from "@nibblets/harness";
import { JsonValue, type Usage } from "@nibblets/protocol";

/** What the mapper has learnt by the end of a turn. */
export interface ClaudeTurnState {
  sessionId: string | null;
  usage: Usage | null;
  /** Set when the result says the turn failed. */
  error: string | null;
  finished: boolean;
}

/**
 * Feeds Agent SDK messages into a `TurnWriter`. Pure apart from the writer,
 * so tests can replay recorded messages without the CLI.
 *
 * Text and thinking stream in as `stream_event`s keyed by message id and
 * block index. The complete `assistant` message that follows repeats them,
 * so its text is only used when nothing streamed for that message (partial
 * messages off, or a frame the stream dropped). Tool calls only come from
 * the complete message, because that is where their input is whole.
 */
export class ClaudeMapper {
  readonly state: ClaudeTurnState = { sessionId: null, usage: null, error: null, finished: false };
  private readonly out: TurnWriter;
  private currentMessageId: string | null = null;
  private readonly streamedMessages = new Set<string>();
  private readonly openBlocks = new Map<number, string>();

  constructor(out: TurnWriter) {
    this.out = out;
  }

  handle(msg: SDKMessage): void {
    if ("session_id" in msg && typeof msg.session_id === "string") {
      this.state.sessionId = msg.session_id;
    }
    switch (msg.type) {
      case "stream_event":
        if (msg.parent_tool_use_id !== null) return;
        this.handleStreamEvent(msg.event);
        return;
      case "assistant":
        if (msg.parent_tool_use_id !== null) return;
        this.handleAssistant(msg.message.id, msg.message.content);
        return;
      case "user":
        if (msg.parent_tool_use_id !== null) return;
        this.handleUser(msg.message.content);
        return;
      case "result":
        this.state.finished = true;
        this.state.usage = {
          inputTokens:
            msg.usage.input_tokens +
            msg.usage.cache_read_input_tokens +
            msg.usage.cache_creation_input_tokens,
          outputTokens: msg.usage.output_tokens,
          cachedInputTokens: msg.usage.cache_read_input_tokens,
        };
        if (msg.subtype !== "success") {
          this.state.error = msg.errors.join("\n") || msg.subtype;
        } else if (msg.is_error) {
          this.state.error = msg.result || "The turn ended on an API error";
        }
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): void {
    switch (event.type) {
      case "message_start":
        this.currentMessageId = event.message.id;
        this.openBlocks.clear();
        return;
      case "content_block_delta": {
        const id = this.blockId(event.index);
        if (!id) return;
        if (event.delta.type === "text_delta") {
          this.mark(id, event.index);
          this.out.delta(id, "assistant_message", event.delta.text);
        } else if (event.delta.type === "thinking_delta") {
          this.mark(id, event.index);
          this.out.delta(id, "reasoning", event.delta.thinking);
        }
        return;
      }
      case "content_block_stop": {
        const id = this.openBlocks.get(event.index);
        if (id) {
          this.openBlocks.delete(event.index);
          this.out.done(id);
        }
        return;
      }
      default:
        return;
    }
  }

  private handleAssistant(
    messageId: string,
    content: Extract<SDKMessage, { type: "assistant" }>["message"]["content"],
  ): void {
    const streamed = this.streamedMessages.has(messageId);
    content.forEach((block, index) => {
      if (block.type === "tool_use" || block.type === "mcp_tool_use") {
        this.out.toolStart(block.id, block.name, toJson(block.input));
      } else if (!streamed && block.type === "text" && block.text) {
        const id = `${messageId}:${index}`;
        this.out.set(id, "assistant_message", block.text);
        this.out.done(id);
      } else if (!streamed && block.type === "thinking" && block.thinking) {
        const id = `${messageId}:${index}`;
        this.out.set(id, "reasoning", block.thinking);
        this.out.done(id);
      }
    });
  }

  private handleUser(content: Extract<SDKMessage, { type: "user" }>["message"]["content"]): void {
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      this.out.toolEnd(block.tool_use_id, toolResultText(block.content), block.is_error === true);
    }
  }

  private blockId(index: number): string | null {
    return this.currentMessageId ? `${this.currentMessageId}:${index}` : null;
  }

  private mark(id: string, index: number): void {
    if (this.currentMessageId) this.streamedMessages.add(this.currentMessageId);
    this.openBlocks.set(index, id);
  }
}

type ToolResultContent = Extract<
  Exclude<Extract<SDKMessage, { type: "user" }>["message"]["content"], string>[number],
  { type: "tool_result" }
>["content"];

function toolResultText(content: ToolResultContent): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return "[image]";
      return `[${part.type}]`;
    })
    .join("\n");
}

/** Tool input arrives typed as `unknown`; keep it only if it is plain JSON. */
export function toJson(value: unknown): JsonValue {
  const parsed = JsonValue.safeParse(value);
  return parsed.success ? parsed.data : String(value);
}
