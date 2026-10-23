import { describe, expect, it } from "vitest";
import { AppLinkError, AppLinkRevokedError, defineField, resolveSettings } from "./index.ts";

const URL = defineField("url", "App URL", { default: "https://app.example.com" });
const TEAM = defineField("team", "Team", { required: true });

describe("resolveSettings", () => {
  it("trims, fills blanks with defaults, and drops what isn't a field", () => {
    expect(resolveSettings([URL, TEAM], { url: "  ", team: " ops ", other: "x" })).toEqual({
      url: "https://app.example.com",
      team: "ops",
    });
  });

  it("says which required field is missing", () => {
    expect(() => resolveSettings([URL, TEAM], {})).toThrow(new AppLinkError("Team is needed"));
  });
});

describe("AppLinkRevokedError", () => {
  it("is an AppLinkError, so its message can be shown", () => {
    const err = new AppLinkRevokedError("grant", "It was revoked");
    expect(err).toBeInstanceOf(AppLinkError);
    expect(err.what).toBe("grant");
  });
});
