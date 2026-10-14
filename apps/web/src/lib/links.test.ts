import { describe, expect, it } from "vitest";
import { isSafeLink } from "./links.ts";

describe("isSafeLink", () => {
  it("allows web and mail addresses", () => {
    expect(isSafeLink("https://nibblets.dev")).toBe(true);
    expect(isSafeLink("http://localhost:8420")).toBe(true);
    expect(isSafeLink("mailto:hello@example.com")).toBe(true);
    expect(isSafeLink("/settings")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("JavaScript:alert(1)")).toBe(false);
    expect(isSafeLink("file:///etc/passwd")).toBe(false);
    expect(isSafeLink("smb://evil/share")).toBe(false);
    expect(isSafeLink("data:text/html,hi")).toBe(false);
  });
});
