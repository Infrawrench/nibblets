import type { Event, Part } from "@opencode-ai/sdk";
import type { TurnWriter } from "@nibblet/harness";
import { JsonValue } from "@nibblet/protocol";

/**
 * Feeds OpenCode server events for one session into a `TurnWriter`.
 *
 * OpenCode streams parts of both the user's and the assistant's messages,
 * so the mapper remembers which message ids are the user's (from
 * `message.updated`) and skips their parts. Text parts carry either a delta
 * or a whole snapshot; a part with `time.end` is finished.
 */
export class OpencodeMapper {
  private readonly out: TurnWriter;
  private readonly sessionId: string;
  private readonly userMessages = new Set<string>();
  private readonly toolsOpen = new Set<string>();
  error: string | null = null;
  idle = false;

  constructor(out: TurnWriter, sessionId: string) {
    this.out = out;
    this.sessionId = sessionId;
  }

  handle(event: Event): void {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info;
        if (info.sessionID !== this.sessionId) return;
        if (info.role === "user") this.userMessages.add(info.id);
        else if (info.error) this.error = errorText(info.error);
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        if (part.sessionID !== this.sessionId || this.userMessages.has(part.messageID)) return;
        this.part(part, event.properties.delta);
        return;
      }
      case "session.error":
        if (event.properties.sessionID && event.properties.sessionID !== this.sessionId) return;
        this.error = event.properties.error ? errorText(event.properties.error) : "OpenCode failed";
        return;
      case "session.idle":
        if (event.properties.sessionID === this.sessionId) this.idle = true;
        return;
      default:
        return;
    }
  }

  private part(part: Part, delta: string | undefined): void {
    switch (part.type) {
      case "text":
      case "reasoning": {
        if (part.type === "text" && (part.synthetic || part.ignored)) return;
        const kind = part.type === "text" ? "assistant_message" : "reasoning";
        if (delta !== undefined) this.out.delta(part.id, kind, delta);
        else this.out.set(part.id, kind, part.text);
        if (part.time?.end !== undefined) {
          // A delta-only stream can miss the start; the final snapshot is authoritative.
          this.out.set(part.id, kind, part.text);
          this.out.done(part.id);
        }
        return;
      }
      case "tool": {
        const state = part.state;
        if (!this.toolsOpen.has(part.callID) || state.status === "running") {
          this.toolsOpen.add(part.callID);
          this.out.toolStart(part.callID, part.tool, toJson(state.input));
        }
        if (state.status === "completed") {
          this.out.toolEnd(part.callID, state.output, false);
        } else if (state.status === "error") {
          this.out.toolEnd(part.callID, state.error, true);
        }
        return;
      }
      default:
        return;
    }
  }
}

function errorText(error: { name: string; data?: { message?: string } }): string {
  return error.data?.message ?? error.name;
}

export function toJson(value: unknown): JsonValue {
  const parsed = JsonValue.safeParse(value);
  return parsed.success ? parsed.data : String(value);
}
