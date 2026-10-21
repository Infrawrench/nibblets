import type { ThreadItem, ThreadItemOf } from "@nibblets/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals, type ApprovalStore } from "./approvals.ts";
import { declinedReply, inspectRequest, toolCallIn } from "./hostmcp.ts";

/** Just the store calls approvals make, recorded. */
function fakeStore() {
  const items: ThreadItem[] = [];
  const awaiting: boolean[] = [];
  const store: ApprovalStore = {
    putItem: async (_nibbletId: string, item: ThreadItemOf<"approval">) => {
      items.push(item);
    },
    updateNibblet: async (_id: string, patch: { awaitingApproval: boolean }) => {
      awaiting.push(patch.awaitingApproval);
    },
    pendingApprovalItems: async () => [],
    clearAwaitingApproval: async () => {},
  };
  return { items, awaiting, store };
}

const last = (items: ThreadItem[]) => {
  const item = items.at(-1);
  if (item?.type !== "approval") throw new Error("expected an approval item");
  return item;
};

describe("Approvals", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const call = { server: "host_mercury", tool: "send_money", input: { amount: 5 } };

  it("holds a call until it's approved", async () => {
    const { items, awaiting, store } = fakeStore();
    const approvals = new Approvals(store, 60_000);
    const decision = approvals.request("nib_1", "turn_1", call);
    await vi.waitFor(() => expect(items).toHaveLength(1));
    expect(last(items)).toMatchObject({ status: "pending", turnId: "turn_1", tool: "send_money" });
    await approvals.decide("nib_1", last(items).id, true);
    await expect(decision).resolves.toEqual({ approved: true, reason: null });
    expect(last(items).status).toBe("approved");
    expect(awaiting).toEqual([true, false]);
  });

  it("passes a decline and its reason back", async () => {
    const { items, store } = fakeStore();
    const approvals = new Approvals(store, 60_000);
    const decision = approvals.request("nib_1", null, call);
    await vi.waitFor(() => expect(items).toHaveLength(1));
    await approvals.decide("nib_1", last(items).id, false, "  not today ");
    await expect(decision).resolves.toEqual({ approved: false, reason: "not today" });
    expect(last(items)).toMatchObject({ status: "denied", reason: "not today" });
  });

  it("expires a call nobody answers", async () => {
    const { items, store } = fakeStore();
    const approvals = new Approvals(store, 60_000);
    const decision = approvals.request("nib_1", null, call);
    await vi.waitFor(() => expect(items).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(decision).resolves.toMatchObject({ approved: false });
    expect(last(items).status).toBe("expired");
  });

  it("declines everything when the turn is stopped, and only that nibblet's", async () => {
    const { items, store } = fakeStore();
    const approvals = new Approvals(store, 60_000);
    const mine = approvals.request("nib_1", null, call);
    const theirs = approvals.request("nib_2", null, call);
    await vi.waitFor(() => expect(items).toHaveLength(2));
    await approvals.cancelAll("nib_1", "The turn was stopped");
    await expect(mine).resolves.toEqual({ approved: false, reason: "The turn was stopped" });
    expect(approvals.waiting("nib_2")).toBe(1);
    void theirs;
  });

  it("won't decide someone else's approval", async () => {
    const { items, store } = fakeStore();
    const approvals = new Approvals(store, 60_000);
    void approvals.request("nib_1", null, call);
    await vi.waitFor(() => expect(items).toHaveLength(1));
    await expect(approvals.decide("nib_2", last(items).id, true)).rejects.toThrow();
  });
});

describe("host tool gate parsing", () => {
  it("finds a tools/call and ignores everything else", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "send_money", arguments: { amount: 5 } },
    });
    expect(toolCallIn(body)).toEqual({ id: 7, tool: "send_money", input: { amount: 5 } });
    expect(toolCallIn(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toBeNull();
    expect(toolCallIn("not json")).toBeNull();
  });

  it("refuses anything that could carry a gated call past the check", () => {
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_money", arguments: {} },
    };
    // A batch, which the bridge would run as is.
    expect(inspectRequest(JSON.stringify([call])).kind).toBe("refuse");
    expect(inspectRequest(JSON.stringify([{ ...call, method: "tools/list" }])).kind).toBe("refuse");
    // A tools/call that's slightly off, so a strict parse would miss it.
    expect(inspectRequest(JSON.stringify({ ...call, jsonrpc: "1.0" })).kind).toBe("refuse");
    expect(inspectRequest(JSON.stringify({ ...call, id: null })).kind).toBe("refuse");
    expect(inspectRequest(JSON.stringify({ ...call, params: { tool: "send_money" } })).kind).toBe(
      "refuse",
    );
    expect(inspectRequest("not json").kind).toBe("refuse");
    expect(inspectRequest("42").kind).toBe("refuse");
    // Everything else goes through, and a proper call is checked.
    expect(inspectRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))).toEqual(
      {
        kind: "other",
      },
    );
    expect(inspectRequest(JSON.stringify(call))).toMatchObject({
      kind: "call",
      tool: "send_money",
    });
  });

  it("answers a declined call as an error result for the same request", () => {
    expect(JSON.parse(declinedReply(7, "no"))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "no" }], isError: true },
    });
  });
});
