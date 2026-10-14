import { GuardApprovalRequest, type GuardConfig, type JsonValue } from "@nibblet/protocol";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Decision } from "./approvals.ts";
import type { Config } from "./config.ts";
import { guardToken, type Store } from "./store.ts";

/** How long one poll waits for the person before answering "still waiting". */
const POLL_MS = 50_000;
/** How long a decision is kept for a guard that hasn't come back for it. */
const KEEP_MS = 10 * 60_000;

export interface GuardDeps {
  config: Pick<Config, "NIBBLET_OWNER_TOKEN">;
  store: Pick<Store, "nibbletRow">;
  conductor: {
    guardConfig(nibbletId: string): Promise<GuardConfig>;
    activeTurnId(nibbletId: string): string | null;
    approvals: {
      request(
        nibbletId: string,
        turnId: string | null,
        call: { server: string; tool: string; input: JsonValue },
      ): Promise<Decision>;
    };
  };
  /** Swapped in tests. */
  pollMs?: number;
}

interface Pending {
  nibbletId: string;
  decision: Promise<Decision>;
  settled: Decision | null;
}

/**
 * Where a nibblet's guard (the user in its container that holds its secrets)
 * gets its settings and asks the person about "ask me first" calls. Each
 * request carries the guard's own token, which the runner and the agent
 * never see.
 *
 * Approvals are long-polled: a request waits up to POLL_MS, then says it's
 * still waiting and the guard asks again by id, so waiting on a person
 * for half an hour never rides on one HTTP request.
 */
export function mountGuard(app: Hono, deps: GuardDeps): void {
  const pending = new Map<string, Pending>();
  const pollMs = deps.pollMs ?? POLL_MS;

  const authorised = async (c: Context): Promise<string | null> => {
    const id = c.req.param("id") ?? "";
    const row = await deps.store.nibbletRow(id).catch(() => null);
    if (!row) return null;
    const expected = Buffer.from(
      `Bearer ${guardToken(deps.config.NIBBLET_OWNER_TOKEN, id, row.tokenHash)}`,
    );
    const got = Buffer.from(c.req.header("authorization") ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected) ? id : null;
  };

  const answer = async (c: Context, approvalId: string, entry: Pending) => {
    const decision = await Promise.race([
      entry.decision,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), pollMs).unref()),
    ]);
    if (!decision) return c.json({ status: "waiting", approvalId });
    pending.delete(approvalId);
    return c.json({ status: "decided", approved: decision.approved, reason: decision.reason });
  };

  app.get("/guard/:id/config", async (c) => {
    const id = await authorised(c);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json(await deps.conductor.guardConfig(id));
  });

  app.post("/guard/:id/approval", async (c) => {
    const id = await authorised(c);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const body = GuardApprovalRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send { server, tool, input }" }, 400);
    const approvalId = randomUUID();
    const entry: Pending = {
      nibbletId: id,
      settled: null,
      decision: deps.conductor.approvals.request(id, deps.conductor.activeTurnId(id), body.data),
    };
    void entry.decision.then(
      (d) => {
        entry.settled = d;
        // A guard that never comes back for it doesn't keep it forever.
        setTimeout(() => pending.delete(approvalId), KEEP_MS).unref();
      },
      () => pending.delete(approvalId),
    );
    pending.set(approvalId, entry);
    return answer(c, approvalId, entry);
  });

  app.get("/guard/:id/approval/:approvalId", async (c) => {
    const id = await authorised(c);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const approvalId = c.req.param("approvalId") ?? "";
    const entry = pending.get(approvalId);
    if (!entry || entry.nibbletId !== id) return c.json({ error: "No such approval" }, 404);
    return answer(c, approvalId, entry);
  });
}
