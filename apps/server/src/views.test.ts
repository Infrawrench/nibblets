import type {
  AppViewContent,
  GuardAppView,
  ServerToRunner,
  ThreadItem,
  ThreadItemOf,
} from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { AppViews, type AppViewStore } from "./views.ts";

/** Just the store calls views make, in memory. */
function fakeStore() {
  const views = new Map<string, AppViewContent>();
  const items: ThreadItem[] = [];
  const store: AppViewStore = {
    putAppView: async (nibbletId, view) => {
      const id = `${nibbletId}:${view.html.length}`;
      views.set(id, view);
      return id;
    },
    appView: async (_nibbletId, id) => views.get(id) ?? null,
    putItem: async (_nibbletId, item: ThreadItemOf<"app_view">) => {
      items.push(item);
    },
    getItem: async (_nibbletId, itemId) => items.find((i) => i.id === itemId) ?? null,
  };
  return { items, store };
}

const report: GuardAppView = {
  server: "fares",
  tool: "search_fares",
  input: { to: "LIS" },
  result: { content: [{ type: "text", text: "3 fares" }] },
  uri: "ui://fares/view.html",
  view: { html: "<p>Fares</p>", csp: {}, permissions: {}, prefersBorder: null },
};

describe("AppViews", () => {
  it("puts a call's view in the thread, keeping its HTML apart", async () => {
    const { items, store } = fakeStore();
    const views = new AppViews(store, () => true);
    await views.record("nib_1", "turn_1", report);
    expect(items).toEqual([
      expect.objectContaining({
        type: "app_view",
        turnId: "turn_1",
        server: "fares",
        tool: "search_fares",
        input: { to: "LIS" },
        result: report.result,
        viewId: "nib_1:12",
      }),
    ]);
    expect(await views.content("nib_1", "nib_1:12")).toEqual(report.view);
    await expect(views.content("nib_1", "nope")).rejects.toThrow("No such view");
  });

  it("won't keep a view or a call that's too big", async () => {
    const { items, store } = fakeStore();
    const views = new AppViews(store, () => true);
    const html = "x".repeat(2 * 1024 * 1024 + 1);
    await expect(
      views.record("nib_1", null, { ...report, view: { ...report.view, html } }),
    ).rejects.toThrow("too big");
    await expect(
      views.record("nib_1", null, { ...report, result: "x".repeat(1024 * 1024) }),
    ).rejects.toThrow("too big");
    expect(items).toEqual([]);
  });

  it("passes a view's call to its runner, on the server the view came from", async () => {
    const { items, store } = fakeStore();
    const sent: ServerToRunner[] = [];
    const views = new AppViews(store, (_id, message) => {
      sent.push(message);
      return true;
    });
    await views.record("nib_1", null, report);
    const item = items[0];
    if (!item) throw new Error("expected an item");

    const answer = views.call("nib_1", item.id, "hold_fare", { flight: "U2" });
    await Promise.resolve();
    const request = sent[0];
    if (request?.type !== "view_call") throw new Error("expected a view_call");
    expect(request).toMatchObject({
      server: "fares",
      tool: "hold_fare",
      arguments: { flight: "U2" },
    });
    // Another nibblet's runner can't answer it.
    views.fromRunner("nib_2", {
      type: "view_call_done",
      requestId: request.requestId,
      result: { content: [] },
      error: null,
    });
    views.fromRunner("nib_1", {
      type: "view_call_done",
      requestId: request.requestId,
      result: { content: [{ type: "text", text: "held U2" }] },
      error: null,
    });
    expect(await answer).toEqual({ content: [{ type: "text", text: "held U2" }] });
  });

  it("says why a view's call failed", async () => {
    const { items, store } = fakeStore();
    let connected = true;
    const views = new AppViews(store, () => connected);
    await views.record("nib_1", null, report);
    const id = items[0]?.id ?? "";

    await expect(views.call("nib_1", "nope", "hold_fare", {})).rejects.toThrow("No such view");
    connected = false;
    await expect(views.call("nib_1", id, "hold_fare", {})).rejects.toThrow("isn't running");
    connected = true;
    const lost = views.call("nib_1", id, "hold_fare", {});
    await Promise.resolve();
    views.runnerGone("nib_1");
    await expect(lost).rejects.toThrow("Lost touch");
  });
});
