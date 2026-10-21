import type { TurnWriter } from "@nibblets/harness";
import { JsonValue, KimiLine } from "@nibblets/protocol";

export interface KimiTurnState {
  /** From the `session.resume_hint` meta line, so the next turn can resume. */
  sessionId: string | null;
  /** Why the turn failed, when the CLI couldn't even be started. */
  error: string | null;
}

type AssistantLine = Extract<KimiLine, { role: "assistant" }>;
type ToolLine = Extract<KimiLine, { role: "tool" }>;
type MetaLine = Extract<KimiLine, { role: "meta" }>;

/**
 * Feeds Kimi's stream-json lines into a `TurnWriter`. Each assistant message
 * is one whole step rather than a delta, so each becomes its own item; a tool
 * call opens on the assistant message that names it and closes on the tool
 * message carrying the same id.
 */
export class KimiMapper {
  readonly state: KimiTurnState = { sessionId: null, error: null };
  private readonly out: TurnWriter;
  /** Kimi's tool call ids, mapped to the item ids the writer knows them by. */
  private readonly tools = new Map<string, string>();
  private messages = 0;

  constructor(out: TurnWriter) {
    this.out = out;
  }

  /** Feeds one line, already checked against `KimiLine`. */
  handle(line: KimiLine): void {
    switch (line.role) {
      case "assistant":
        return this.assistant(line);
      case "tool":
        return this.tool(line);
      case "meta":
        return this.meta(line);
    }
  }

  private assistant(line: AssistantLine): void {
    for (const call of line.tool_calls ?? []) {
      if (this.tools.has(call.id)) continue;
      const itemId = `${this.out.turnId}:tool:${call.id}`;
      this.tools.set(call.id, itemId);
      this.out.toolStart(itemId, call.function.name, parseArguments(call.function.arguments));
    }
    if (!line.content?.trim()) return;
    const id = `${this.out.turnId}:msg:${this.messages++}`;
    this.out.set(id, "assistant_message", line.content);
    this.out.done(id);
  }

  private tool(line: ToolLine): void {
    const itemId = this.tools.get(line.tool_call_id);
    if (!itemId) return;
    this.tools.delete(line.tool_call_id);
    // stream-json doesn't say whether a tool failed, only what it returned.
    this.out.toolEnd(itemId, line.content, false);
  }

  private meta(line: MetaLine): void {
    const sessionId = line.session_id;
    if (typeof sessionId === "string" && sessionId) this.state.sessionId = sessionId;
    // A retry is only a warning: the attempt after it may well succeed, and
    // if none does the CLI exits non-zero with the reason on stderr.
    const message = line.error_message;
    if (typeof message === "string" && message) this.out.notice("warning", message);
  }
}

/** Tool arguments are a JSON string on the wire; anything else stays as text. */
export function parseArguments(args: unknown): JsonValue {
  if (typeof args !== "string" || !args.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const value = JsonValue.safeParse(parsed);
  return value.success ? value.data : args;
}
