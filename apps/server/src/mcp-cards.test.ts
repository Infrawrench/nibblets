import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_MACHINE, defaultHamsterLook, type Card, type Nibblet } from "@nibblet/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Decision } from "./approvals.ts";
import { buildServer, type ToolDeps } from "./mcp.ts";

const nibblet: Nibblet = {
  id: "nib_1",
  name: "Pip",
  promptName: null,
  plain: false,
  machine: DEFAULT_MACHINE,
  windowsProductKey: null,
  look: defaultHamsterLook,
  harness: "codex",
  model: "gpt-5",
  effort: "medium",
  instructions: "",
  parentId: null,
  status: "working",
  statusDetail: null,
  resources: { cpus: null, memoryMb: null },
  monthlyBudgetUsd: null,
  snapshotPolicy: { everyMinutes: 1440, keep: 7 },
  heartbeats: [],
  browser: true,
  hostTools: [],
  cliCredentials: [],
  mcpServers: [],
  toolApprovals: [],
  tailscale: null,
  tailnetNode: null,
  spendingLimits: [],
  location: null,
  statusText: "Booking flights",
  statusEmoji: "✈️",
  statusUpdatedAt: "2026-10-21T12:00:00.000Z",
  awaitingApproval: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastActivityAt: null,
};

const card: Card = {
  id: "card_1",
  nibbletId: "nib_1",
  provider: "stripe",
  asset: { code: "USD", decimals: 2 },
  kind: "single_use",
  limit: "50000",
  spent: "0",
  purpose: "Flights",
  display: "•••• 4242",
  state: "open",
  closedBy: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  closedAt: null,
};

const Result = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
});

describe("card_verify", () => {
  let current: Nibblet;
  let asked: number;
  let decide: (decision: Decision) => void;
  let client: Client;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    current = { ...nibblet };
    asked = 0;
    const deps = {
      store: {
        getNibblet: async () => current,
        updateNibblet: async (_id: string, patch: Partial<Record<string, unknown>>) => {
          const statusUpdatedAt = patch.statusUpdatedAt;
          current = {
            ...current,
            ...patch,
            statusUpdatedAt: statusUpdatedAt instanceof Date ? statusUpdatedAt.toISOString() : null,
          };
        },
      },
      conductor: {
        activeTurnId: () => "turn_1",
        approvals: {
          request: () => {
            asked++;
            return new Promise<Decision>((resolve) => {
              decide = resolve;
            });
          },
        },
      },
      bank: { enabled: true, providers: () => [], cards: async () => [card] },
      scheduler: {},
      notifier: {},
      connect: {},
    } as unknown as ToolDeps;
    const [ours, theirs] = InMemoryTransport.createLinkedPair();
    await buildServer(nibblet, deps).connect(ours);
    client = new Client({ name: "test", version: "1" });
    await client.connect(theirs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const call = async (name: string, args: Record<string, string>) =>
    Result.parse(await client.callTool({ name, arguments: args }));
  const verify = (cardId = "card_1") =>
    call("card_verify", { card: cardId, merchant: "British Airways", asks: "A texted code" });

  it("waits for the person, and puts the nibblet's status back after", async () => {
    const result = verify();
    await vi.waitFor(() => expect(asked).toBe(1));
    expect(current.statusText).toBe(
      "Needs you to verify a payment to British Airways in its browser",
    );
    decide({ approved: true, reason: null });
    expect((await result).content[0]?.text).toContain("it's done");
    await vi.waitFor(() => expect(current.statusText).toBe("Booking flights"));
    expect(current).toMatchObject({ statusEmoji: "✈️", statusUpdatedAt: nibblet.statusUpdatedAt });
  });

  it("returns before a harness would give up, and can be waited on again", async () => {
    const first = verify();
    await vi.waitFor(() => expect(asked).toBe(1));
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await first).content[0]?.text).toContain("card_verify_wait with card card_1");
    // Asking again waits on the same request rather than making another.
    const again = verify();
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await again).content[0]?.text).toContain("hasn't finished yet");
    expect(asked).toBe(1);
    const waited = call("card_verify_wait", { card: "card_1" });
    decide({ approved: false, reason: null });
    const answer = await waited;
    expect(answer.isError).toBe(true);
    expect(answer.content[0]?.text).toContain("didn't verify it");
    await vi.waitFor(() => expect(current.statusText).toBe("Booking flights"));
    // Once it's been told, there's nothing left to wait on.
    expect((await call("card_verify_wait", { card: "card_1" })).isError).toBe(true);
  });

  it("refuses a card the nibblet doesn't have open", async () => {
    const result = await verify("card_9");
    expect(result.isError).toBe(true);
    expect(asked).toBe(0);
  });
});
