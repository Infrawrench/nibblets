import {
  MAX_APP_VIEW_BYTES,
  MAX_APP_VIEW_CALL_BYTES,
  RpcError,
  type AppViewContent,
  type GuardAppView,
  type JsonValue,
  type RunnerToServer,
  type ServerToRunner,
  type ThreadItem,
  type ThreadItemOf,
} from "@nibblets/protocol";
import { RunnerRequests } from "./runner-requests.ts";
import { newId } from "./store.ts";

type Done = Extract<RunnerToServer, { type: "view_call_done" }>;

/** The store calls views need, so tests can stand in for the database. */
export interface AppViewStore {
  putAppView(nibbletId: string, view: AppViewContent): Promise<string>;
  appView(nibbletId: string, id: string): Promise<AppViewContent | null>;
  putItem(nibbletId: string, item: ThreadItemOf<"app_view">): Promise<unknown>;
  getItem(nibbletId: string, itemId: string): Promise<ThreadItem | null>;
}

/**
 * How long a view's call may take: it can wait on "ask me first", and a
 * browser action can be slow.
 */
const CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * MCP App views in nibblets' threads. The guard reports each call of a tool
 * with a view (`record`), which becomes an `app_view` item; the web app
 * fetches the view's HTML (`content`), shows it in a sandboxed frame, and
 * passes on the view's own tool calls (`call`) to the runner, which makes
 * them through the gate.
 */
export class AppViews {
  private readonly store: AppViewStore;
  private readonly requests: RunnerRequests<Done>;

  /** `send` says whether the nibblet's runner is connected to send to. */
  constructor(
    store: AppViewStore,
    send: (nibbletId: string, message: ServerToRunner) => boolean,
    timeoutMs = CALL_TIMEOUT_MS,
  ) {
    this.store = store;
    this.requests = new RunnerRequests("viewcall", send, timeoutMs);
  }

  /** Puts a call's view in the thread. Throws for one too big to keep. */
  async record(nibbletId: string, turnId: string | null, report: GuardAppView): Promise<void> {
    if (new TextEncoder().encode(report.view.html).length > MAX_APP_VIEW_BYTES) {
      throw new Error("The view is too big to show");
    }
    const call = JSON.stringify({ input: report.input, result: report.result });
    if (new TextEncoder().encode(call).length > MAX_APP_VIEW_CALL_BYTES) {
      throw new Error("The call is too big to show in its view");
    }
    const viewId = await this.store.putAppView(nibbletId, report.view);
    await this.store.putItem(nibbletId, {
      type: "app_view",
      id: newId("view"),
      turnId,
      createdAt: new Date().toISOString(),
      server: report.server,
      tool: report.tool,
      input: report.input,
      result: report.result,
      viewId,
    });
  }

  async content(nibbletId: string, viewId: string): Promise<AppViewContent> {
    const view = await this.store.appView(nibbletId, viewId);
    if (!view) throw new RpcError("not_found", "No such view");
    return view;
  }

  /** A view's own tool call, on the server its item came from. */
  async call(
    nibbletId: string,
    itemId: string,
    tool: string,
    args: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    const item = await this.store.getItem(nibbletId, itemId);
    if (item?.type !== "app_view") throw new RpcError("not_found", "No such view");
    try {
      const done = await this.requests.request(nibbletId, (requestId) => ({
        type: "view_call",
        requestId,
        server: item.server,
        tool,
        arguments: args,
      }));
      if (done.result === null) throw new Error("The tool didn't answer");
      return done.result;
    } catch (err) {
      throw new RpcError("conflict", err instanceof Error ? err.message : String(err));
    }
  }

  fromRunner(nibbletId: string, done: Done): void {
    this.requests.fromRunner(nibbletId, done);
  }

  runnerGone(nibbletId: string): void {
    this.requests.runnerGone(nibbletId);
  }
}
