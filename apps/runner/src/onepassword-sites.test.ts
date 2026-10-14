import { describe, expect, it } from "vitest";
import { addressBar, hostOf, parseTree, sameSite, usernameField } from "./onepassword-sites.ts";

// The shape OpenComputerUse gives for Chromium.
const TREE = [
  '[e0] Window "Sign in to GitHub - Chromium" @(0,0 1440x900)',
  "  [e4] Toolbar @(0,40 1440x46)",
  '    [e9] TextField "Address and search bar" value="github.com/login" @(158,51 1153x24) actions=press,showmenu',
  '  [e59] WebArea "Sign in to GitHub" @(0,87 1440x813) actions=showmenu focused',
  '    [e60] TextField "Search" @(10,90 100x20)',
  '    [e61] TextField "Username or email address" @(500,300 300x30) actions=press',
  '    [e62] TextField "Password" @(500,360 300x30) actions=press',
  '    [e63] Button "Sign in"',
].join("\n");

describe("sites", () => {
  it("matches a host to itself and its subdomains, and nothing else", () => {
    expect(sameSite("login.example.com", "example.com")).toBe(true);
    expect(sameSite("github.com", "github.com")).toBe(true);
    expect(sameSite("x.co.uk", "evil.co.uk")).toBe(false);
    expect(sameSite("notgithub.com", "github.com")).toBe(false);
    expect(sameSite("", "github.com")).toBe(false);
    expect(hostOf("https://GitHub.com/login")).toBe("github.com");
    expect(hostOf("github.com/login")).toBe("github.com");
  });
});

describe("the browser's tree", () => {
  it("reads the address bar and whether it's being edited", () => {
    const nodes = parseTree(TREE);
    expect(addressBar(nodes)).toMatchObject({
      id: "e9",
      value: "github.com/login",
      focused: false,
    });
    const editing = parseTree(
      TREE.replace("actions=press,showmenu", "actions=press,showmenu focused"),
    );
    expect(addressBar(editing)?.focused).toBe(true);
  });

  it("finds the username field on the page, not the search box or the address bar", () => {
    expect(usernameField(parseTree(TREE))?.id).toBe("e61");
  });

  it("finds nothing on a page with no fields", () => {
    expect(
      usernameField(parseTree('[e0] Window "x"\n  [e1] WebArea "x"\n    [e2] Button "Go"')),
    ).toBeNull();
  });
});
