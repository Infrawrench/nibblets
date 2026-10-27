import {
  isWebUrl,
  type AppGrant,
  type AppLinkDescription,
  type AppLinkAttempt,
  type AppLinkOutcome,
} from "@nibblets/protocol";

/**
 * Where to send the person to approve a link: its page with the code
 * filled in if there is one. Null for anything but http or https, which is
 * never opened or linked to.
 */
export function approvalPage(attempt: AppLinkAttempt): string | null {
  const url = attempt.verificationUrlComplete ?? attempt.verificationUrl;
  return isWebUrl(url) ? url : null;
}

/** What a nibblet's form for one link holds before it's saved. */
export interface GrantDraft {
  on: boolean;
  scopes: string[];
  /** Empty for all of them. */
  providers: string[];
}

/** The form as a grant (or none) leaves it. */
export function grantDraftOf(grant: AppGrant | undefined): GrantDraft {
  return grant && grant.state !== "revoking"
    ? { on: true, scopes: [...grant.scopes], providers: [...grant.providers] }
    : { on: false, scopes: [], providers: [] };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Whether saving would change anything: turning it on, or other scopes or
 * providers. A grant the app revoked is saved again to make a new one.
 */
export function grantDraftChanged(draft: GrantDraft, grant: AppGrant | undefined): boolean {
  if (!draft.on) return false;
  if (!grant || grant.state !== "active") return true;
  return !same(draft.scopes, grant.scopes) || !same(draft.providers, grant.providers);
}

/**
 * Whether a scope can be ticked with providers chosen: only ones the app
 * says choosing providers limits (`narrowable`, null for all of them).
 */
export function canNarrow(scope: string, narrowable: readonly string[] | null): boolean {
  return narrowable === null || narrowable.includes(scope);
}

/**
 * The form with other providers chosen. Once there's any, scopes they can't
 * limit are unticked, since they'd still reach every provider.
 */
export function withProviders(
  draft: GrantDraft,
  providers: string[],
  narrowable: readonly string[] | null,
): GrantDraft {
  const scopes =
    providers.length > 0 ? draft.scopes.filter((s) => canNarrow(s, narrowable)) : draft.scopes;
  return { ...draft, providers, scopes };
}

/**
 * What Select all ticks: every scope the app offers, less those the
 * providers chosen can't limit.
 */
export function tickableScopes(
  description: AppLinkDescription,
  providers: readonly string[],
): string[] {
  const all = description.scopeGroups.flatMap((g) => g.scopes.map((s) => s.value));
  return providers.length > 0 ? all.filter((s) => canNarrow(s, description.narrowable)) : all;
}

/** A list with one item ticked or unticked. */
export function ticked(list: readonly string[], item: string, on: boolean): string[] {
  return on ? [...new Set([...list, item])] : list.filter((x) => x !== item);
}

/** How an attempt to link ended, in words for Settings. */
export function outcomeText(
  outcome: AppLinkOutcome,
  name: string,
  detail: string | null,
): string | null {
  switch (outcome) {
    case "linked":
      return null;
    case "denied":
      return `It was turned down in ${name}.`;
    case "expired":
      return "The code ran out before it was approved. Link again for a new one.";
    case "cancelled":
      return null;
    case "failed":
      return detail ?? `${name} couldn't link.`;
  }
}
