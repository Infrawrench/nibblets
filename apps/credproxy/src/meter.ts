import { emptyUsage, type ApiUsage } from "@nibblet/protocol";
import { isRecord } from "./providers/provider.ts";

/** What a response said it used, once it's over. */
export interface Metered {
  model: string;
  usage: ApiUsage;
}

/** The shape of usage on the wire: Anthropic's Messages API (and DeepSeek's copy of it), or OpenAI's Responses API. */
export type Dialect = "anthropic" | "openai";

/** A JSON (not streamed) response bigger than this isn't read for usage. */
const MAX_JSON = 16 * 1024 * 1024;

/**
 * Passes a response body through untouched, reading its usage on the way:
 * each event of a stream, or the whole of a JSON body. `done` is called once,
 * when the body ends or the client goes away, with whatever usage it had
 * reported by then (null if none), so an interrupted stream still counts
 * what it had used.
 */
export function meter(
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  contentType: string | null,
  done: (metered: Metered | null) => void,
): ReadableStream<Uint8Array> {
  const reader = new UsageReader(dialect, (contentType ?? "").includes("text/event-stream"));
  const upstream = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done(reader.result());
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
        reader.push(decoder.decode(value, { stream: true }));
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
  private buffer = "";
  private tooBig = false;
  private model = "";
  private usage: ApiUsage | null = null;

  constructor(dialect: Dialect, sse: boolean) {
    this.dialect = dialect;
    this.sse = sse;
  }

  push(text: string): void {
    if (!this.sse) {
      if (this.tooBig) return;
      this.buffer += text;
      if (this.buffer.length > MAX_JSON) {
        this.tooBig = true;
        this.buffer = "";
      }
      return;
    }
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    }
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
      }
    }
    this.buffer = "";
  }

  result(): Metered | null {
    return this.usage ? { model: this.model, usage: this.usage } : null;
  }

  private event(data: string): void {
    const event = parse(data);
    if (!isRecord(event)) return;
    if (this.dialect === "anthropic") {
      // The input side comes first, the output side's running total after.
      if (event.type === "message_start" && isRecord(event.message)) {
        this.anthropicMessage(event.message);
      } else if (event.type === "message_delta" && isRecord(event.usage)) {
        this.anthropicUsage(event.usage);
      }
    } else if (
      (event.type === "response.completed" ||
        event.type === "response.incomplete" ||
        event.type === "response.failed") &&
      isRecord(event.response)
    ) {
      this.openaiResponse(event.response);
    }
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
      next.cacheWriteTokens = u.cache_creation_input_tokens;
    }
    if (isCount(u.output_tokens)) next.outputTokens = u.output_tokens;
    if (isRecord(u.server_tool_use) && isCount(u.server_tool_use.web_search_requests)) {
      next.webSearches = u.server_tool_use.web_search_requests;
    }
    this.usage = next;
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
