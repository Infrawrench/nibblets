import type { CredentialStatus } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { budgetApplies } from "./budget.ts";

const credential = (
  provider: CredentialStatus["provider"],
  source: CredentialStatus["source"],
): CredentialStatus => ({
  provider,
  source,
  ok: source !== "none",
  detail: "",
  plan: null,
  expiresAt: null,
  limitedUntil: null,
});

const subscriptions = [
  credential("anthropic", "file"),
  credential("openai", "keychain"),
  credential("deepseek", "none"),
];
const top = { parentId: null, monthlyBudgetUsd: null };

describe("budgetApplies", () => {
  it("is hidden when nothing on the server is an API key", () => {
    expect(budgetApplies(top, subscriptions)).toBe(false);
    expect(budgetApplies(top, undefined)).toBe(false);
  });

  it("shows once any provider is on a key, whatever the nibblet's harness", () => {
    expect(budgetApplies(top, [...subscriptions.slice(0, 2), credential("deepseek", "env")])).toBe(
      true,
    );
    expect(budgetApplies(top, [credential("openai", "env")])).toBe(true);
  });

  it("stays while a budget is set, so it can be cleared", () => {
    expect(budgetApplies({ parentId: null, monthlyBudgetUsd: 5 }, subscriptions)).toBe(true);
  });

  it("never shows for a sub-agent, which spends its parent's", () => {
    expect(
      budgetApplies({ parentId: "nib_p", monthlyBudgetUsd: null }, [credential("openai", "env")]),
    ).toBe(false);
  });
});
