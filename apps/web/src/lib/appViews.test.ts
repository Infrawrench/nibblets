import { describe, expect, it } from "vitest";
import { grantedPermissions, viewHeight, viewPolicy, withPolicy } from "./appViews.ts";

describe("viewPolicy", () => {
  it("allows only the view's own inline code when it names nowhere else", () => {
    const policy = viewPolicy({});
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain("'self'");
  });

  it("adds the places the view names, where they belong", () => {
    const policy = viewPolicy({
      connectDomains: ["https://api.fares.test", "wss://live.fares.test:8443"],
      resourceDomains: ["https://*.cdn.test/assets/"],
      frameDomains: ["https://maps.test"],
    });
    expect(policy).toContain("connect-src https://api.fares.test wss://live.fares.test:8443");
    expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.test/assets/");
    expect(policy).toContain("img-src data: blob: https://*.cdn.test/assets/");
    expect(policy).toContain("frame-src https://maps.test");
  });

  it("leaves out anything that isn't a plain address", () => {
    const policy = viewPolicy({
      connectDomains: [
        "*",
        "'unsafe-eval'",
        "https://a.test; script-src *",
        "javascript:x",
        "data:",
      ],
    });
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy.split(";").filter((d) => d.trim().startsWith("script-src"))).toHaveLength(1);
  });
});

describe("withPolicy", () => {
  it("puts the policy first, after any doctype", () => {
    const html = withPolicy("<!DOCTYPE html><html><p>hi</p></html>", {});
    expect(html.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(withPolicy("<p>hi</p>", {})).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
  });
});

describe("grantedPermissions", () => {
  it("gives the clipboard, never the camera, microphone or location", () => {
    expect(
      grantedPermissions({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }),
    ).toEqual({ clipboardWrite: {} });
    expect(grantedPermissions({ geolocation: {} })).toEqual({});
  });
});

describe("viewHeight", () => {
  it("follows the view, within bounds", () => {
    expect(viewHeight(300.2, 160)).toBe(301);
    expect(viewHeight(5000, 160)).toBe(720);
    expect(viewHeight(0, 160)).toBe(24);
    expect(viewHeight(undefined, 160)).toBe(160);
  });
});
