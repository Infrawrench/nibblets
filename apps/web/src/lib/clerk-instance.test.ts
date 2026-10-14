import { describe, expect, it } from "vitest";
import { clerkCookieNames, needsClearing } from "./clerk-instance.ts";

describe("leftover Clerk state", () => {
  it("picks out Clerk's cookies and nothing else", () => {
    expect(
      clerkCookieNames(
        "__client_uat=0; __client_uat_Ab12=1; __session=x; __clerk_db_jwt=y; __refresh_Ab12=z; theme=dark",
      ),
    ).toEqual([
      "__client_uat",
      "__client_uat_Ab12",
      "__session",
      "__clerk_db_jwt",
      "__refresh_Ab12",
    ]);
    expect(clerkCookieNames("")).toEqual([]);
  });

  it("clears when the instance changed, or isn't known yet", () => {
    expect(needsClearing(null, "pk_live_a")).toBe(true);
    expect(needsClearing("pk_test_a", "pk_live_a")).toBe(true);
    expect(needsClearing("pk_live_a", "pk_live_a")).toBe(false);
  });
});
