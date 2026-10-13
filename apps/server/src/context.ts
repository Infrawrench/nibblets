import type { Memory, Nibblet, ThreadItem, TurnSource } from "@nibblet/protocol";

export const QUIET_REPLY = "NO_REPLY";

const DEFAULT_HEARTBEAT = `This is a heartbeat: a regular check-in with no message from the user.
Look after anything you're responsible for: follow up on open threads, check things you said you'd keep an eye on, and tidy your memory.
If something needs the user's attention, say so plainly. If nothing does, reply with exactly ${QUIET_REPLY} and nothing else.`;

export function heartbeatInput(nibblet: Nibblet): string {
  const checklist = nibblet.heartbeat.prompt?.trim();
  return checklist ? `${DEFAULT_HEARTBEAT}\n\nYour checklist:\n${checklist}` : DEFAULT_HEARTBEAT;
}

export function scheduleInput(name: string, prompt: string): string {
  return `Scheduled task "${name}" is due.\n\n${prompt}\n\nIf there's nothing worth telling the user, reply with exactly ${QUIET_REPLY}.`;
}

/** Whether a heartbeat or schedule reply means "nothing to report". */
export function isQuiet(source: TurnSource, reply: string): boolean {
  if (source !== "heartbeat" && source !== "schedule") return false;
  const trimmed = reply.trim();
  return (
    trimmed === QUIET_REPLY || trimmed.startsWith(QUIET_REPLY) || trimmed.endsWith(QUIET_REPLY)
  );
}

const RECAP_ITEMS = 40;
const RECAP_CHARS = 1200;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A compact transcript for a harness session that starts without history. */
export function recap(items: ThreadItem[]): string {
  const lines: string[] = [];
  for (const item of items.slice(-RECAP_ITEMS)) {
    if (item.type === "user_message") {
      lines.push(
        `[${item.source === "user" ? "user" : item.source}] ${clip(item.text, RECAP_CHARS)}`,
      );
    } else if (item.type === "assistant_message" && !item.streaming) {
      lines.push(`[you] ${clip(item.text, RECAP_CHARS)}`);
    } else if (item.type === "subagent") {
      lines.push(`[sub-agent ${item.childId}: ${item.status}] ${clip(item.task, 200)}`);
    }
  }
  return lines.join("\n");
}

export interface SystemPromptInput {
  nibblet: Nibblet;
  serverName: string;
  memories: Memory[];
  /** Set when the harness session is fresh and has no history of its own. */
  history: ThreadItem[] | null;
  parent: Nibblet | null;
  now: Date;
}

export function systemPrompt(input: SystemPromptInput): string {
  const { nibblet } = input;
  const parts: string[] = [];

  parts.push(
    `You are ${nibblet.name}, a nibblet: a long-running personal agent (drawn as a hamster in the UI) living in its own Docker container on the "${input.serverName}" nibblet server. You keep working between messages: a heartbeat and schedules wake you up, and you can spawn sub-agents.`,
  );

  if (input.parent) {
    parts.push(
      `You are a sub-agent of ${input.parent.name}. Do the task you were given, then finish with a clear, self-contained final answer: it is sent back to ${input.parent.name} as your result.`,
    );
  }

  parts.push(
    nibblet.instructions.trim()
      ? `## Your instructions\n\n${nibblet.instructions.trim()}`
      : "## Your instructions\n\nYou don't have any yet. Work out what the user wants you for from your conversation, then write it down with `instructions_update`.",
  );

  const rules = [
    "Your instructions are yours to maintain: when the user tells you what you're for or how they want things done, fold it into them with `instructions_update`.",
    "Your container's disk is scratch space and can be wiped at any time. Anything worth keeping goes into memory with `memory_save`; check `memory_search` before asking the user something you may already know.",
    "Use `schedule_create` for anything that should happen at a set time or repeatedly, and `heartbeat_configure` for regular check-ins. Don't promise to do something later without scheduling it.",
    "For work that splits into independent pieces, `spawn_subagent` starts a child nibblet; its answer comes back to you as a message.",
    `On heartbeat and scheduled turns, if there's nothing worth telling the user, reply with exactly ${QUIET_REPLY}.`,
  ];
  if (nibblet.browser) {
    rules.push(
      "You have a Chromium browser through the `computer` tools (OpenComputerUse): `list_sessions` first, and if none is open, `start_session` with app `chromium` (pass the URL as an argument). The user can watch it and take control; if they're using it, wait rather than fighting over the mouse.",
    );
  }
  parts.push(`## How you work\n\n${rules.map((r) => `- ${r}`).join("\n")}`);

  if (input.memories.length > 0) {
    const lines = input.memories.map(
      (m) => `- (${m.id}${m.nibbletId === null ? ", shared" : ""}) ${m.content}`,
    );
    parts.push(`## Memories that may be relevant\n\n${lines.join("\n")}`);
  }

  if (input.history && input.history.length > 0) {
    parts.push(
      `## The conversation so far\n\nYour working session was restarted, so here is a recap of this thread:\n\n${recap(input.history)}`,
    );
  }

  parts.push(`Current time: ${input.now.toISOString()}.`);
  return parts.join("\n\n");
}
