import { emptyUsage, type ApiUsage } from "@nibblets/protocol";
import { isRecord } from "./providers/provider.ts";

/** What a response used: as it said, or as near as can be told when it didn't finish saying. */
export interface Metered {
  model: string;
  usage: ApiUsage;
}

/** The shape of usage on the wire: Anthropic's Messages API (and DeepSeek's copy of it), or OpenAI's Responses API. */
export type Dialect = "anthropic" | "openai";

/** A JSON (not streamed) response bigger than this isn't read for usage. */
const MAX_JSON = 16 * 1024 * 1024;

/**
 * Characters per token, for guessing at what hasn't been counted yet. Low,
 * so a guess comes out high: a budget should run out early, not late.
 */
const CHARS_PER_TOKEN = 3;

const tokensIn = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * A guess at what a request will use before its response says: its model,
 * and its body's length as input. Null for anything that doesn't generate
 * (counting tokens, listing models), which costs nothing.
 */
export function estimateRequest(
  dialect: Dialect,
  method: string,
  path: string,
  body: ArrayBuffer | null,
): Metered | null {
  const generates =
    method === "POST" &&
    (dialect === "anthropic" ? /\/messages$/.test(path) : /\/responses$/.test(path));
  if (!generates || !body) return null;
  const text = new TextDecoder().decode(body);
  const parsed = parse(text);
  const model = isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : "";
  return { model, usage: { ...emptyUsage, inputTokens: tokensIn(text.length) } };
}

export interface MeterOptions {
  dialect: Dialect;
  contentType: string | null;
  /** What to count if the response ends without saying what it used. Null counts nothing. */
  estimate: Metered | null;
  /** Called as what the response has used so far changes. */
  progress?: (metered: Metered) => void;
  /** Called once, when the body ends or the client goes away. */
  done: (metered: Metered | null) => void;
}

/**
 * Passes a response body through untouched, reading its usage on the way:
 * each event of a stream, or the whole of a JSON body. A stream the harness
 * stops reading still counts its input, and the output it had streamed by
 * then, since the provider charges for both.
 */
export function meter(
  body: ReadableStream<Uint8Array>,
  opts: MeterOptions,
): ReadableStream<Uint8Array> {
  const reader = new UsageReader(
    opts.dialect,
    (opts.contentType ?? "").includes("text/event-stream"),
    opts.estimate,
  );
  const upstream = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    opts.done(reader.result());
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: ended } = await upstream.read();
        if (ended) {
          reader.push(decoder.decode());
          reader.end();
          finish();
          controller.close();
          return;
        }
        if (reader.push(decoder.decode(value, { stream: true }))) {
          const now = reader.result();
          if (now) opts.progress?.(now);
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await upstream.cancel(reason);
    },
  });
}

/** Reads usage out of a body fed to it in pieces. */
export class UsageReader {
  private readonly dialect: Dialect;
  private readonly sse: boolean;
  private readonly estimate: Metered | null;
  private buffer = "";
  private tooBig = false;
  private model: string;
  private usage: ApiUsage | null = null;
  /** Whether the response has said what it used in full, rather than only begun to. */
  private complete = false;
  /** Generated text streamed so far, for when it stops before saying how much that was. */
  private streamedChars = 0;
  private changed = false;

  constructor(dialect: Dialect, sse: boolean, estimate: Metered | null = null) {
    this.dialect = dialect;
    this.sse = sse;
    this.estimate = estimate;
    this.model = estimate?.model ?? "";
  }

  /** Feeds it the next piece; true if what's been used so far changed. */
  push(text: string): boolean {
    this.changed = false;
    if (!this.sse) {
      if (this.tooBig) return false;
      this.buffer += text;
      if (this.buffer.length > MAX_JSON) {
        this.tooBig = true;
        this.buffer = "";
      }
      return false;
    }
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    }
    return this.changed;
  }

  end(): void {
    if (this.sse) {
      const line = this.buffer.trim();
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    } else if (!this.tooBig) {
      const body = parse(this.buffer);
      if (isRecord(body)) {
        if (this.dialect === "anthropic") this.anthropicMessage(body);
        else this.openaiResponse(body);
        if (this.usage) this.complete = true;
      }
    }
    this.buffer = "";
  }

  /**
   * What it has used: the response's own count once complete; before that,
   * whatever it has said so far (or the estimate), with at least the output
   * streamed so far.
   */
  result(): Metered | null {
    if (this.complete && this.usage) return { model: this.model, usage: this.usage };
    const usage = this.usage ?? this.estimate?.usage ?? null;
    if (!usage && this.streamedChars === 0) return null;
    const base = usage ?? emptyUsage;
    return {
      model: this.model,
      usage: { ...base, outputTokens: Math.max(base.outputTokens, tokensIn(this.streamedChars)) },
    };
  }

  private event(data: string): void {
    const event = parse(data);
    if (!isRecord(event)) return;
    if (this.dialect === "anthropic") {
      // The input side comes first, the output side's running total last.
      if (event.type === "message_start" && isRecord(event.message)) {
        this.anthropicMessage(event.message);
      } else if (event.type === "content_block_delta" && isRecord(event.delta)) {
        const d = event.delta;
        for (const text of [d.text, d.partial_json, d.thinking]) this.streamed(text);
      } else if (event.type === "message_delta" && isRecord(event.usage)) {
        this.anthropicUsage(event.usage);
        this.complete = true;
      }
    } else if (
      (event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed") &&
      isRecord(event.response)
    ) {
      this.openaiResponse(event.response);
      if (this.usage) this.complete = true;
    } else if (typeof event.type === "string" && event.type.endsWith(".delta")) {
      this.streamed(event.delta);
    }
  }

  private streamed(text: unknown): void {
    if (typeof text !== "string" || text.length === 0) return;
    this.streamedChars += text.length;
    this.changed = true;
  }

  private anthropicMessage(message: Record<string, unknown>): void {
    if (typeof message.model === "string") this.model = message.model;
    if (isRecord(message.usage)) this.anthropicUsage(message.usage);
  }

  /** Fields it leaves out keep what an earlier event said; the totals it gives are running ones. */
  private anthropicUsage(u: Record<string, unknown>): void {
    const next = { ...(this.usage ?? emptyUsage) };
    if (isCount(u.input_tokens)) next.inputTokens = u.input_tokens;
    if (isCount(u.cache_read_input_tokens)) next.cachedInputTokens = u.cache_read_input_tokens;
    if (isRecord(u.cache_creation)) {
      const c = u.cache_creation;
      if (isCount(c.ephemeral_5m_input_tokens)) next.cacheWriteTokens = c.ephemeral_5m_input_tokens;
      if (isCount(c.ephemeral_1h_input_tokens))
        next.cacheWrite1hTokens = c.ephemeral_1h_input_tokens;
    } else if (isCount(u.cache_creation_input_tokens)) {
      // The total of both lifetimes: what isn't already known to be the hour's is the five minutes'.
      next.cacheWriteTokens = Math.max(0, u.cache_creation_input_tokens - next.cacheWrite1hTokens);
    }
    if (isCount(u.output_tokens)) next.outputTokens = u.output_tokens;
    if (isRecord(u.server_tool_use) && isCount(u.server_tool_use.web_search_requests)) {
      next.webSearches = u.server_tool_use.web_search_requests;
    }
    this.usage = next;
    this.changed = true;
  }

  private openaiResponse(response: Record<string, unknown>): void {
    if (typeof response.model === "string") this.model = response.model;
    const u = response.usage;
    if (!isRecord(u)) return;
    const input = isCount(u.input_tokens) ? u.input_tokens : 0;
    const cached =
      isRecord(u.input_tokens_details) && isCount(u.input_tokens_details.cached_tokens)
        ? u.input_tokens_details.cached_tokens
        : 0;
    const searches = Array.isArray(response.output)
      ? response.output.filter((o) => isRecord(o) && o.type === "web_search_call").length
      : 0;
    this.usage = {
      ...emptyUsage,
      // OpenAI counts cached input in input_tokens.
      inputTokens: Math.max(0, input - cached),
      cachedInputTokens: cached,
      outputTokens: isCount(u.output_tokens) ? u.output_tokens : 0,
      webSearches: searches,
    };
    this.changed = true;
  }
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
