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
  /**
   * The version of the CLI it ships with (the npm package in
   * `harnesses[id].cli`), so the server can tell when a newer one is out.
   */
  bundledCli(): string;
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
  /** The nibblet's working folder, on its home volume: kept across restarts. */
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

/** A file the user attached, already saved in the workdir. */
export interface TurnAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface TurnRequest {
  turnId: string;
  source: TurnSource;
  input: string;
  system: string;
  signal: AbortSignal;
  /** Files the user attached; images go to the model as images where the harness can. */
  attachments?: TurnAttachment[];
}

/** Images a model can look at directly. */
export function isModelImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime);
}

/** The input text plus a line naming every attached file and where it is. */
export function inputWithAttachments(
  input: string,
  attachments: readonly TurnAttachment[] = [],
): string {
  if (attachments.length === 0) return input;
  const lines = attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes): ${a.path}`);
  return `${input}\n\nThe user attached ${attachments.length === 1 ? "a file" : "files"}, saved at:\n${lines.join("\n")}`;
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

interface TextEntry {
  kind: "assistant_message" | "reasoning";
  text: string;
  createdAt: string;
  /** How much of `text` has been shown, and when it last grew. */
  shown: number;
  shownAt: number;
}

/**
 * Where the last whole sentence (or line) in `text` ends: after a `.`, `!`,
 * `?` or `…` (and any closing quotes or brackets) followed by a space, or at
 * a line break. 0 when there isn't one yet.
 */
export function sentenceEnd(text: string): number {
  let end = 0;
  for (const m of text.matchAll(/[.!?…]["'”’)\]]*\s|\n/g)) end = m.index + m[0].length;
  return end;
}

/**
 * Turns a harness's stream of deltas and tool events into whole thread
 * items. Text is accumulated per item and shown a sentence (or line) at a
 * time rather than token by token, checked every `flushMs`; a stretch with
 * no sentence end (code, say) shows anyway after `holdMs`. That also keeps a
 * fast stream to a handful of upserts. Harness plugins use this rather than
 * building items themselves.
 */
export class TurnWriter {
  private readonly texts = new Map<string, TextEntry>();
  private readonly tools = new Map<string, Extract<ThreadItem, { type: "tool_call" }>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly turnId: string;
  private readonly emit: (item: ThreadItem) => void;
  private readonly flushMs: number;
  private readonly holdMs: number;

  constructor(turnId: string, emit: (item: ThreadItem) => void, flushMs = 80, holdMs = 2000) {
    this.turnId = turnId;
    this.emit = emit;
    this.flushMs = flushMs;
    this.holdMs = holdMs;
  }

  /** Appends to an assistant message or reasoning block, creating it on first use. */
  delta(itemId: string, kind: "assistant_message" | "reasoning", text: string): void {
    const entry = this.entry(itemId, kind);
    entry.text += text;
    this.texts.set(itemId, entry);
    this.dirty.add(itemId);
    this.schedule();
  }

  /** Replaces a text item outright, for harnesses that send whole snapshots. */
  set(itemId: string, kind: "assistant_message" | "reasoning", text: string): void {
    const entry = this.entry(itemId, kind);
    entry.text = text;
    entry.shown = Math.min(entry.shown, text.length);
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

  private entry(itemId: string, kind: TextEntry["kind"]): TextEntry {
    return (
      this.texts.get(itemId) ?? {
        kind,
        text: "",
        createdAt: now(),
        shown: 0,
        shownAt: Date.now(),
      }
    );
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const id of this.dirty) {
        const entry = this.texts.get(id);
        if (!entry) {
          this.dirty.delete(id);
          continue;
        }
        // Up to the last whole sentence; everything, once it's been held long enough.
        const held = Date.now() - entry.shownAt >= this.holdMs;
        const upTo = held ? entry.text.length : sentenceEnd(entry.text);
        if (upTo > entry.shown && entry.text.slice(0, upTo).trim()) {
          entry.shown = upTo;
          entry.shownAt = Date.now();
          this.emit(this.textItem(id, { ...entry, text: entry.text.slice(0, upTo) }, true));
        }
        if (entry.shown >= entry.text.length) this.dirty.delete(id);
      }
      // Text still held back gets another look.
      if (this.dirty.size > 0) this.schedule();
    }, this.flushMs);
  }

  private textItem(
    id: string,
    entry: Pick<TextEntry, "kind" | "text" | "createdAt">,
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
  const version = packageField(entryUrl, name, "version");
  return typeof version === "string" ? version : "unknown";
}

/** One field of the package.json of the package `name` that `entryUrl` is in. */
export function packageField(entryUrl: string, name: string, field: string): unknown {
  let dir = path.dirname(fileURLToPath(entryUrl));
  for (;;) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof pkg === "object" && pkg !== null && "name" in pkg && pkg.name === name) {
        return field in pkg ? Object.entries(pkg).find(([k]) => k === field)?.[1] : undefined;
      }
    } catch {
      // No package.json here; keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
export { installedCli, installedCliDir } from "./cli.ts";
