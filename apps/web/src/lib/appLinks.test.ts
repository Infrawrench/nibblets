import type { AppGrant } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { approvalPage, grantDraftChanged, grantDraftOf, ticked } from "./appLinks.ts";

const grant: AppGrant = {
  nibbletId: "nib_1",
  linkId: "lnk_1",
  scopes: ["resources:read", "secrets:read"],
  providers: [],
  state: "active",
  detail: null,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
};

describe("a nibblet's grant form", () => {
  it("starts from its grant, and changes only when something does", () => {
    const draft = grantDraftOf(grant);
    expect(draft).toEqual({ on: true, scopes: grant.scopes, providers: [] });
    expect(grantDraftChanged(draft, grant)).toBe(false);
    // The order they were ticked in doesn't matter.
    expect(grantDraftChanged({ ...draft, scopes: ["secrets:read", "resources:read"] }, grant)).toBe(
      false,
    );
    expect(grantDraftChanged({ ...draft, providers: ["aws"] }, grant)).toBe(true);
  });

  it("is off without a grant, and saves anew over one the app revoked", () => {
    expect(grantDraftOf(undefined).on).toBe(false);
    expect(grantDraftChanged({ on: true, scopes: ["x"], providers: [] }, undefined)).toBe(true);
    const revoked = { ...grant, state: "revoked" as const };
    expect(grantDraftChanged(grantDraftOf(revoked), revoked)).toBe(true);
    expect(grantDraftOf({ ...grant, state: "revoking" }).on).toBe(false);
  });

  it("ticks and unticks", () => {
    expect(ticked(["a"], "b", true)).toEqual(["a", "b"]);
    expect(ticked(["a", "b"], "a", false)).toEqual(["b"]);
    expect(ticked(["a"], "a", true)).toEqual(["a"]);
  });
});

describe("the page to approve a link on", () => {
  const attempt = {
    id: "lna_1",
    plugin: "infrawrench",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://app.infrawrench.com/link-agents",
    verificationUrlComplete: "https://app.infrawrench.com/link-agents?code=ABCD-EFGH",
    expiresAt: "2026-10-23T10:15:00.000Z",
  };

  it("is the one with the code filled in, else the plain one", () => {
    expect(approvalPage(attempt)).toBe(attempt.verificationUrlComplete);
    expect(approvalPage({ ...attempt, verificationUrlComplete: null })).toBe(
      attempt.verificationUrl,
    );
  });

  it("is never anything but a web page", () => {
    expect(approvalPage({ ...attempt, verificationUrlComplete: "javascript:alert(1)" })).toBeNull();
    expect(
      approvalPage({
        ...attempt,
        verificationUrl: "data:text/html,x",
        verificationUrlComplete: null,
      }),
    ).toBeNull();
  });
});
