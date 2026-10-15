import type { TurnWriter } from "@nibblet/harness";
import { JsonValue, KimiLine } from "@nibblet/protocol";

export interface KimiTurnState {
  /** From the `session.resume_hint` meta line, so the next turn can resume. */
  sessionId: string | null;
  version: string | null;
  error: string | null;
  finished: boolean;
}

/**
 * Feeds Kimi's stream-json lines into a `TurnWriter`. Assistant messages
 * arrive whole rather than as deltas, so each becomes its own item; a tool
 * call opens on the assistant message that names it and closes on the tool
 * message carrying the same id.
 */
export class KimiMapper {
  readonly state: KimiTurnState = {
    sessionId: null,
    version: null,
    error: null,
    finished: false,
  };
  private readonly out: TurnWriter;
  /** Kimi's tool call ids, mapped to the item ids the writer knows them by. */
  private readonly tools = new Map<string, string>();
  private messages = 0;

  constructor(out: TurnWriter) {
    this.out = out;
  }

  /** Feeds one line. Anything that doesn't parse is ignored, as Kimi's own. */
  handle(line: unknown): void {
    const parsed = KimiLine.safeParse(line);
    if (!parsed.success) return;
    const record = parsed.data as Record<string, unknown>;
    switch (record.role) {
      case "assistant":
        this.assistant(record);
        return;
      case "tool":
        this.tool(record);
        return;
      case "meta":
        this.meta(record);
        return;
      default:
        return;
    }
  }

  /** Called once the CLI's stdout closes. */
  finish(): void {
    this.state.finished = true;
  }

  private assistant(record: Record<string, unknown>): void {
    const calls = record.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
        const { id, function: fn } = call as { id?: unknown; function?: unknown };
        if (typeof id !== "string" || fn === null || typeof fn !== "object") continue;
        const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
        if (typeof name !== "string" || this.tools.has(id)) continue;
        const itemId = `${this.out.turnId}:tool:${id}`;
        this.tools.set(id, itemId);
        this.out.toolStart(itemId, name, parseArguments(args));
      }
    }
    const content = record.content;
    if (typeof content !== "string" || !content.trim()) return;
    const id = `${this.out.turnId}:msg:${this.messages++}`;
    this.out.set(id, "assistant_message", content);
    this.out.done(id);
  }

  private tool(record: Record<string, unknown>): void {
    const id = record.tool_call_id;
    if (typeof id !== "string") return;
    const itemId = this.tools.get(id);
    if (!itemId) return;
    this.tools.delete(id);
    const content = record.content;
    this.out.toolEnd(itemId, typeof content === "string" ? content : "", false);
  }

  private meta(record: Record<string, unknown>): void {
    const sessionId = record.session_id;
    if (typeof sessionId === "string" && sessionId) this.state.sessionId = sessionId;
    const version = record.version;
    if (typeof version === "string" && version) this.state.version ??= version;
    const message = record.error_message;
    if (typeof message === "string" && message) {
      this.state.error ??= message;
      this.out.notice("warning", message);
    }
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
