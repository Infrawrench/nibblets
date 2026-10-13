import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HarnessId,
  JsonValue,
  RunnerConfig,
  ThreadItem,
  TurnSource,
  Usage,
} from "@nibblet/protocol";

/**
 * The contract every harness plugin fulfils. A harness is an agent loop we
 * don't own (Claude Agent SDK, Codex, OpenCode); its plugin translates
 * between that loop and nibblet thread items. Everything nibblet-specific
 * (memory, schedules, sub-agents) reaches the harness as MCP tools, so a
 * plugin only has to know how to hand its harness MCP servers.
 */
export interface HarnessPlugin {
  readonly id: HarnessId;
  /** The harness's own version, for the UI and bug reports. */
  version(): string;
  open(ctx: HarnessContext): Promise<HarnessSession>;
}

export interface HarnessSession {
  run(turn: TurnRequest, out: TurnWriter): Promise<TurnResult>;
  close(): Promise<void>;
}

export type McpServerSpec =
  | { type: "http"; url: string; headers: Record<string, string> }
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> };

export interface HarnessContext {
  config: RunnerConfig;
  /** The nibblet's scratch directory. Not durable; durable data goes through tools. */
  workdir: string;
  mcpServers: Record<string, McpServerSpec>;
  /** Base URL of the credential proxy; `/anthropic` and `/openai` hang off it. */
  credproxyUrl: string;
  /**
   * Shared secret the proxy checks. Harnesses send it wherever they would
   * send an API key: `x-api-key` for Anthropic, a bearer token for OpenAI.
   */
  credproxyKey: string;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface TurnRequest {
  turnId: string;
  source: TurnSource;
  input: string;
  system: string;
  signal: AbortSignal;
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  error: string | null;
  usage: Usage | null;
  sessionId: string | null;
}

export function defineHarness(plugin: HarnessPlugin): HarnessPlugin {
  return plugin;
}

/** Splits `mcp__server__tool` (Claude) or `server.tool` style names. */
export function splitToolName(raw: string): { server: string | null; name: string } {
  const claude = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (claude?.[1] && claude[2]) return { server: claude[1], name: claude[2] };
  return { server: null, name: raw };
}

/**
 * Turns a harness's stream of deltas and tool events into whole thread
 * items. Text is accumulated per item and flushed at most every
 * `flushMs`, so a fast stream costs a handful of upserts rather than one per
 * token. Harness plugins use this rather than building items themselves.
 */
export class TurnWriter {
  private readonly texts = new Map<
    string,
    { kind: "assistant_message" | "reasoning"; text: string; createdAt: string }
  >();
  private readonly tools = new Map<string, Extract<ThreadItem, { type: "tool_call" }>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly turnId: string;
  private readonly emit: (item: ThreadItem) => void;
  private readonly flushMs: number;

  constructor(turnId: string, emit: (item: ThreadItem) => void, flushMs = 80) {
    this.turnId = turnId;
    this.emit = emit;
    this.flushMs = flushMs;
  }

  /** Appends to an assistant message or reasoning block, creating it on first use. */
  delta(itemId: string, kind: "assistant_message" | "reasoning", text: string): void {
    const entry = this.texts.get(itemId) ?? { kind, text: "", createdAt: now() };
    entry.text += text;
    this.texts.set(itemId, entry);
    this.dirty.add(itemId);
    this.schedule();
  }

  /** Replaces a text item outright, for harnesses that send whole snapshots. */
  set(itemId: string, kind: "assistant_message" | "reasoning", text: string): void {
    const entry = this.texts.get(itemId) ?? { kind, text: "", createdAt: now() };
    entry.text = text;
    this.texts.set(itemId, entry);
    this.dirty.add(itemId);
    this.schedule();
  }

  /** Marks a text item finished. */
  done(itemId: string): void {
    const entry = this.texts.get(itemId);
    if (!entry) return;
    this.dirty.delete(itemId);
    this.texts.delete(itemId);
    // Some models open a thinking block and say nothing in it.
    if (!entry.text.trim()) return;
    this.emit(this.textItem(itemId, entry, false));
  }

  toolStart(itemId: string, rawName: string, input: JsonValue): void {
    const { server, name } = splitToolName(rawName);
    const item: Extract<ThreadItem, { type: "tool_call" }> = {
      type: "tool_call",
      id: itemId,
      turnId: this.turnId,
      createdAt: now(),
      name,
      server,
      input,
      output: null,
      status: "running",
    };
    this.tools.set(itemId, item);
    this.emit(item);
  }

  toolEnd(itemId: string, output: string, isError: boolean): void {
    const item = this.tools.get(itemId);
    if (!item) return;
    this.tools.delete(itemId);
    this.emit({ ...item, output: truncate(output), status: isError ? "error" : "done" });
  }

  notice(level: "info" | "warning" | "error", text: string): void {
    this.emit({
      type: "notice",
      id: crypto.randomUUID(),
      turnId: this.turnId,
      createdAt: now(),
      level,
      text,
    });
  }

  /** Flushes everything and closes any items the harness left open. */
  finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const id of [...this.texts.keys()]) this.done(id);
    for (const [id, item] of this.tools)
      this.emit({ ...item, status: "error", output: item.output ?? "Interrupted" });
    this.tools.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const id of this.dirty) {
        const entry = this.texts.get(id);
        if (entry?.text.trim()) this.emit(this.textItem(id, entry, true));
      }
      this.dirty.clear();
    }, this.flushMs);
  }

  private textItem(
    id: string,
    entry: { kind: "assistant_message" | "reasoning"; text: string; createdAt: string },
    streaming: boolean,
  ): ThreadItem {
    return {
      type: entry.kind,
      id,
      turnId: this.turnId,
      createdAt: entry.createdAt,
      text: entry.text,
      streaming,
    };
  }
}

const MAX_OUTPUT = 16_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} more characters)`
    : s;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The version of an installed package, found by walking up from its resolved
 * entry point. Works for packages whose `exports` hide `package.json`. Pass
 * `import.meta.resolve(name)` from the caller, so resolution starts there.
 */
export function packageVersion(entryUrl: string, name: string): string {
  let dir = path.dirname(fileURLToPath(entryUrl));
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (
        typeof pkg === "object" &&
        pkg !== null &&
        "name" in pkg &&
        pkg.name === name &&
        "version" in pkg &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    } catch {
      // No package.json here; keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}
