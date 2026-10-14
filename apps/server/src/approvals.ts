import { declinedMessage, RpcError, type JsonValue, type ThreadItemOf } from "@nibblet/protocol";
import { newId } from "./store.ts";

/** The store calls approvals need, so tests can stand in for the database. */
export interface ApprovalStore {
  putItem(nibbletId: string, item: ThreadItemOf<"approval">): Promise<unknown>;
  updateNibblet(id: string, patch: { awaitingApproval: boolean }): Promise<unknown>;
  pendingApprovalItems(): Promise<{ nibbletId: string; item: ThreadItemOf<"approval"> }[]>;
  clearAwaitingApproval(): Promise<void>;
}

export interface Decision {
  approved: boolean;
  /** Why, for the agent to read when it was declined. */
  reason: string | null;
}

interface Pending {
  nibbletId: string;
  item: ThreadItemOf<"approval">;
  resolve: (decision: Decision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What a declined call returns to the agent. */
export function declinedText(decision: Decision): string {
  return declinedMessage(decision.reason);
}

/**
 * Gated tool calls waiting for the user. A call is held until someone
 * approves or declines it in the UI, the turn is stopped, or it times out;
 * each becomes an `approval` item in the thread so the UI can show it.
 */
export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private readonly store: ApprovalStore;
  private readonly timeoutMs: number;

  constructor(store: ApprovalStore, timeoutMs: number) {
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  /** After a restart nothing is waiting on old approvals: close them and clear the flags. */
  async resetStale(): Promise<void> {
    for (const { nibbletId, item } of await this.store.pendingApprovalItems()) {
      await this.store.putItem(nibbletId, {
        ...item,
        status: "expired",
        reason: "The server restarted while this was waiting",
        decidedAt: new Date().toISOString(),
      });
    }
    await this.store.clearAwaitingApproval();
  }

  async request(
    nibbletId: string,
    turnId: string | null,
    call: { server: string; tool: string; input: JsonValue },
  ): Promise<Decision> {
    const item: ThreadItemOf<"approval"> = {
      type: "approval",
      id: newId("appr"),
      turnId,
      createdAt: new Date().toISOString(),
      server: call.server,
      tool: call.tool,
      input: call.input,
      status: "pending",
      reason: null,
      decidedAt: null,
    };
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(
        () => void this.settle(item.id, "expired", "No one approved this in time"),
        this.timeoutMs,
      );
      this.pending.set(item.id, { nibbletId, item, resolve, timer });
    });
    await this.store.putItem(nibbletId, item);
    await this.store.updateNibblet(nibbletId, { awaitingApproval: true });
    return decision;
  }

  async decide(nibbletId: string, approvalId: string, approve: boolean, reason?: string) {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.nibbletId !== nibbletId) {
      throw new RpcError("not_found", "That approval isn't waiting any more");
    }
    await this.settle(approvalId, approve ? "approved" : "denied", reason?.trim() || null);
  }

  /** Declines everything a nibblet is waiting on, when its turn is stopped. */
  async cancelAll(nibbletId: string, reason: string): Promise<void> {
    const ids = [...this.pending].filter(([, p]) => p.nibbletId === nibbletId).map(([id]) => id);
    for (const id of ids) await this.settle(id, "denied", reason);
  }

  waiting(nibbletId: string): number {
    return [...this.pending.values()].filter((p) => p.nibbletId === nibbletId).length;
  }

  private async settle(
    approvalId: string,
    status: "approved" | "denied" | "expired",
    reason: string | null,
  ): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);
    entry.resolve({ approved: status === "approved", reason });
    await this.store.putItem(entry.nibbletId, {
      ...entry.item,
      status,
      reason,
      decidedAt: new Date().toISOString(),
    });
    if (this.waiting(entry.nibbletId) === 0) {
      await this.store
        .updateNibblet(entry.nibbletId, { awaitingApproval: false })
        .catch(() => undefined);
    }
  }
}
