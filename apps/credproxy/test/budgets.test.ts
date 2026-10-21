import { emptyUsage, type BudgetStatus, type MeteredRequest } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { BudgetGate, type BudgetClient } from "../src/budgets.ts";
import { estimateRequest, UsageReader } from "../src/meter.ts";

const sse = (...events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("UsageReader", () => {
  it("doesn't count an hour's cache write twice when the last event only gives the total", () => {
    const reader = new UsageReader("anthropic", true);
    reader.push(
      sse(
        {
          type: "message_start",
          message: {
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 3000,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3000 },
              output_tokens: 1,
            },
          },
        },
        { type: "message_delta", usage: { cache_creation_input_tokens: 3000, output_tokens: 40 } },
      ),
    );
    reader.end();
    expect(reader.result()?.usage).toMatchObject({
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 3000,
      outputTokens: 40,
    });
  });

  it("counts the output a cut-off Claude stream had sent, not message_start's placeholder", () => {
    const reader = new UsageReader("anthropic", true);
    reader.push(
      sse(
        {
          type: "message_start",
          message: { model: "m", usage: { input_tokens: 9, output_tokens: 1 } },
        },
        { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(3000) } },
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "y".repeat(300) },
        },
      ),
    );
    // No message_delta: the harness stopped reading.
    expect(reader.result()?.usage).toMatchObject({ inputTokens: 9, outputTokens: 1100 });
  });

  it("falls back to the request's estimate when a cut-off Codex stream never said", () => {
    const estimate = { model: "gpt-6-sol", usage: { ...emptyUsage, inputTokens: 500 } };
    const reader = new UsageReader("openai", true, estimate);
    reader.push(sse({ type: "response.output_text.delta", delta: "z".repeat(30) }));
    expect(reader.result()).toEqual({
      model: "gpt-6-sol",
      usage: { ...emptyUsage, inputTokens: 500, outputTokens: 10 },
    });
  });

  it("takes the response's own count over the estimate once it has one", () => {
    const estimate = { model: "gpt-6-sol", usage: { ...emptyUsage, inputTokens: 999_999 } };
    const reader = new UsageReader("openai", false, estimate);
    reader.push(
      JSON.stringify({ model: "gpt-6-sol", usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    reader.end();
    expect(reader.result()?.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });
});

describe("estimateRequest", () => {
  const body = (o: object) => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;

  it("guesses at requests that generate, and not at ones that don't", () => {
    const req = body({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] });
    const guess = estimateRequest("anthropic", "POST", "/anthropic/v1/messages", req);
    expect(guess?.model).toBe("claude-sonnet-5-5");
    expect(guess?.usage.inputTokens).toBeGreaterThan(0);
    expect(
      estimateRequest("anthropic", "POST", "/anthropic/v1/messages/count_tokens", req),
    ).toBeNull();
    expect(estimateRequest("openai", "GET", "/openai/models", null)).toBeNull();
    expect(
      estimateRequest("openai", "POST", "/openai/responses", body({ model: "gpt-6-sol" }))?.model,
    ).toBe("gpt-6-sol");
  });
});

function server(status: Partial<BudgetStatus>) {
  const reports: MeteredRequest[] = [];
  let checks = 0;
  let down = false;
  let failReports = 0;
  const answer = (nibbletId: string): BudgetStatus => ({
    nibbletId,
    budgetUsd: 1,
    spentUsd: 0,
    month: "2026-10",
    resetsAt: "2026-11-01T00:00:00.000Z",
    allowed: true,
    ...status,
  });
  const client: BudgetClient = {
    async check(nibbletId) {
      checks++;
      if (down) throw new Error("connection refused");
      return answer(nibbletId);
    },
    async report(request) {
      if (failReports > 0) {
        failReports--;
        throw new Error("server restarting");
      }
      reports.push(request);
      return answer(request.nibbletId);
    },
  };
  return {
    client,
    reports,
    checks: () => checks,
    setDown: (v: boolean) => (down = v),
    failNextReports: (n: number) => (failReports = n),
  };
}

const opusOut = (outputTokens: number) => ({
  model: "claude-opus-5-5",
  usage: { ...emptyUsage, outputTokens },
});

describe("BudgetGate", () => {
  it("counts requests still under way, so several at once can't all spend the same room", async () => {
    const s = server({ budgetUsd: 1, spentUsd: 0.5 });
    const gate = new BudgetGate(s.client, { log: () => {} });
    expect((await gate.check("nib_a")).allowed).toBe(true);
    // $0.60 of Opus output in flight, at a guess.
    const first = gate.begin("nib_a", "anthropic", opusOut(30_000));
    expect(await gate.check("nib_a")).toMatchObject({ allowed: false, spentUsd: 1.1 });
    first.finish(null);
    expect((await gate.check("nib_a")).allowed).toBe(true);
  });

  it("keeps counting a report the server didn't take, and tries again until it does", async () => {
    const s = server({ budgetUsd: 1, spentUsd: 0 });
    const gate = new BudgetGate(s.client, { retryMs: 1, log: () => {} });
    s.failNextReports(2);
    gate.begin("nib_a", "anthropic", null).finish(opusOut(60_000));
    expect((await gate.check("nib_a")).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.reports).toHaveLength(1);
  });

  it("asks the server at most every few seconds, and uses what it last said while it's away", async () => {
    let now = 0;
    const s = server({ budgetUsd: 1, spentUsd: 0 });
    const gate = new BudgetGate(s.client, { now: () => now, log: () => {} });
    await gate.check("nib_a");
    await gate.check("nib_a");
    expect(s.checks()).toBe(1);
    now = 10_000;
    s.setDown(true);
    expect((await gate.check("nib_a")).allowed).toBe(true);
    now = 10 * 60_000;
    await expect(gate.check("nib_a")).rejects.toThrow(/connection refused/);
    await expect(gate.check("nib_b")).rejects.toThrow(/connection refused/);
  });
});
