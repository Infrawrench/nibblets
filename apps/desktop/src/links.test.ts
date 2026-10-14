import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
const { isExternalSafe, navigationAllowed } = await import("./links.ts");

describe("desktop links", () => {
  it("hands only web and mail addresses to the system", () => {
    expect(isExternalSafe("https://github.com")).toBe(true);
    expect(isExternalSafe("mailto:a@b.c")).toBe(true);
    expect(isExternalSafe("smb://evil/share")).toBe(false);
    expect(isExternalSafe("file:///Applications/Calculator.app")).toBe(false);
    expect(isExternalSafe("javascript:alert(1)")).toBe(false);
    expect(isExternalSafe("nonsense")).toBe(false);
  });

  it("keeps the window on the UI and its sign-in", () => {
    const ui = "http://127.0.0.1:8420/";
    expect(navigationAllowed("http://127.0.0.1:8420/settings", ui)).toBe(true);
    expect(navigationAllowed("https://evil.example/login", ui)).toBe(false);
    expect(navigationAllowed("http://127.0.0.1:9999/", ui)).toBe(false);
    const central = "https://app.nibblets.dev/";
    expect(navigationAllowed("https://close-foal-8519.clerk.accounts.dev/v1/oauth", central)).toBe(
      true,
    );
    expect(navigationAllowed("https://accounts.google.com/o/oauth2/auth", central)).toBe(true);
    expect(navigationAllowed("http://accounts.google.com/", central)).toBe(false);
    expect(navigationAllowed("https://accounts.google.com.evil.example/", central)).toBe(false);
  });
});
