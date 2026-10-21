import type { CredentialStatus, Nibblet } from "@nibblets/protocol";

/**
 * Whether a nibblet's budget can matter: the server has an API key (Claude
 * or ChatGPT on one, or DeepSeek's), which it or a sub-agent, on any
 * harness, could spend. One already set stays shown, so it can be cleared.
 * Sub-agents spend their parent's, so never theirs.
 */
export function budgetApplies(
  nibblet: Pick<Nibblet, "parentId" | "monthlyBudgetUsd">,
  credentials: readonly CredentialStatus[] | undefined,
): boolean {
  if (nibblet.parentId) return false;
  if (nibblet.monthlyBudgetUsd !== null) return true;
  return credentials?.some((c) => c.source === "env") ?? false;
}
