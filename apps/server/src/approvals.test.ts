import type { ThreadItem, ThreadItemOf } from "@nibblet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals, type ApprovalStore } from "./approvals.ts";
import { declinedReply, toolCallIn } from "./hostmcp.ts";

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

  it("answers a declined call as an error result for the same request", () => {
    expect(JSON.parse(declinedReply(7, "no"))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "no" }], isError: true },
    });
  });
});
