import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
const { isExternalSafe, isProviderSignIn, navigationAllowed, parseSignInLink } =
  await import("./links.ts");

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
    expect(navigationAllowed("https://clerk.app.nibblets.dev/v1/client", central)).toBe(true);
    // Social sign-ins go to the browser instead.
    expect(navigationAllowed("https://accounts.google.com/o/oauth2/auth", central)).toBe(false);
  });

  it("sends social sign-ins to the browser", () => {
    expect(isProviderSignIn("https://accounts.google.com/o/oauth2/auth?x=1")).toBe(true);
    expect(isProviderSignIn("https://github.com/login/oauth/authorize")).toBe(true);
    expect(isProviderSignIn("http://accounts.google.com/")).toBe(false);
    expect(isProviderSignIn("https://accounts.google.com.evil.example/")).toBe(false);
    expect(isProviderSignIn("https://app.nibblets.dev/")).toBe(false);
  });

  it("reads a sign-in coming back from the browser", () => {
    expect(parseSignInLink("nibblets://sign-in?state=abc&handle=def")).toEqual({
      state: "abc",
      handle: "def",
    });
    expect(parseSignInLink("nibblets://sign-in?state=abc")).toBeNull();
    expect(parseSignInLink("nibblets://other?state=abc&handle=def")).toBeNull();
    expect(parseSignInLink("https://sign-in/?state=abc&handle=def")).toBeNull();
  });
});
