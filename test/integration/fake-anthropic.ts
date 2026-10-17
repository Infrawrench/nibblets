/**
 * A stand-in for the credential proxy and the Anthropic API behind it, for
 * integration tests: the real Claude Code harness in a real nibblet talks
 * to this, and every answer is the same short reply, so a turn runs end
 * to end with no credentials and no model. Plain Node, no dependencies, so
 * it runs in a stock node image with this file mounted.
 *
 *   node fake-anthropic.ts [port]
 *
 * A message that asks it to (`SPAWN: <task>`) is answered once with a call to
 * the nibblet's own spawn_subagent tool, so sub-agents get tested too: the
 * harness calls it, and the tool's result comes back for the real reply.
 *
 * GET /requests says how many model calls it has had, and what each offered
 * and was answered with, for the tests to say why something didn't happen.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const REPLY = "pong from the fake model";
/** The nibblet MCP server's spawn_subagent, as Claude Code names it. */
const SPAWN_TOOL = "mcp__nibblet__spawn_subagent";

let requests = 0;
/** Each call, briefly: the tools it offered, the end of its last message, and the answer. */
const calls: { tools: string[]; last: string; answer: string }[] = [];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface Block {
  type?: string;
  text?: string;
  content?: string | Block[];
}
interface Request {
  stream?: boolean;
  model?: string;
  tools?: { name?: string }[];
  messages?: { role?: string; content?: string | Block[] }[];
}

/** A message's text, tools' results included. */
function textOf(content: string | Block[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((b) => `${b.type === "tool_result" ? "[result] " : ""}${b.text ?? textOf(b.content)}`)
    .join("\n");
}

async function body(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    const parsed: Request = JSON.parse(Buffer.concat(chunks).toString());
    return parsed;
  } catch {
    return {};
  }
}

/** The blocks of the user's messages since the model last spoke: Claude Code adds its own around the prompt, and its context after. */
function userTurn(request: Request): Block[] {
  const messages = request.messages ?? [];
  const from = messages.findLastIndex((m) => m.role === "assistant") + 1;
  return messages
    .slice(from)
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []),
    );
}

/** A task to spawn a sub-agent for, if the user's turn asks for one and isn't a tool's result. */
function spawnTask(request: Request): string | null {
  const blocks = userTurn(request);
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const text = blocks.map((b) => b.text ?? "").join("\n");
  return /SPAWN: (.+)/.exec(text)?.[1]?.trim() ?? null;
}

/** One assistant message, as the Messages API streams it: the reply, or a call to spawn a sub-agent. */
function stream(res: ServerResponse, model: string, task: string | null): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_fake${requests}`;
  event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  if (task) {
    const input = JSON.stringify({ name: "Child", task });
    event("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_fake${requests}`, name: SPAWN_TOOL, input: {} },
    });
    event("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: input },
    });
  } else {
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } });
  }
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: task ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  event("message_stop", {});
  res.end();
}

export function startFake(port: number) {
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://fake").pathname;
      if (req.method === "GET" && path === "/status") return json(res, 200, []);
      if (req.method === "GET" && path === "/requests") return json(res, 200, { requests, calls });
      if (req.method === "POST" && path.endsWith("/v1/messages/count_tokens")) {
        return json(res, 200, { input_tokens: 10 });
      }
      if (req.method === "POST" && path.endsWith("/v1/messages")) {
        requests++;
        const request = await body(req);
        const model = request.model ?? "claude-fake";
        const task = spawnTask(request);
        calls.push({
          tools: (request.tools ?? []).map((t) => t.name ?? ""),
          last: textOf(userTurn(request)).slice(0, 300),
          answer: request.stream && task ? `spawn: ${task}` : REPLY,
        });
        if (request.stream) return stream(res, model, task);
        return json(res, 200, {
          id: `msg_fake${requests}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: REPLY }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      json(res, 404, { type: "error", error: { type: "not_found_error", message: path } });
    })();
  });
  server.listen(port, "0.0.0.0");
  return server;
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8787);
  startFake(port);
  console.log(`fake anthropic on :${port}`);
}
