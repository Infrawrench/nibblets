import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonValue, RunnerToServer, ServerToRunner } from "@nibblets/protocol";

type ViewCall = Extract<ServerToRunner, { type: "view_call" }>;
type ViewCallDone = Extract<RunnerToServer, { type: "view_call_done" }>;

/** As long as the server waits, since the call may wait on "ask me first". */
const CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Makes an MCP App view's own tool call, through the gate as the view
 * (`/app/<server>`, which `appUrl` gives), and says how it went.
 */
export async function callForView(
  call: ViewCall,
  appUrl: (server: string) => string,
): Promise<ViewCallDone> {
  const client = new Client({ name: "nibblet-views", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(appUrl(call.server))));
    const result = await client.callTool(
      { name: call.tool, arguments: call.arguments },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const json: JsonValue = JSON.parse(JSON.stringify(result));
    return { type: "view_call_done", requestId: call.requestId, result: json, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { type: "view_call_done", requestId: call.requestId, result: null, error };
  } finally {
    await client.close().catch(() => {});
  }
}
