import { describe, expect, it } from "vitest";
import { BOOTSTRAP_SH, OCU_REQUIREMENT, tccSql } from "../src/provision.ts";

describe("macOS guests' images", () => {
  it("give each app its permission for the code its developer signed alone", () => {
    const sql = tccSql([
      {
        service: "kTCCServiceAccessibility",
        client: "com.example.app",
        clientType: 0,
        csreq: "fade0c00",
      },
      {
        service: "kTCCServiceSystemPolicyAllFiles",
        client: "/opt/bin/node",
        clientType: 1,
        csreq: "fade0c01",
      },
    ]);
    expect(sql).toContain(
      "VALUES ('kTCCServiceAccessibility', 'com.example.app', 0, 2, 4, 1, X'fade0c00', 0);",
    );
    expect(sql).toContain("VALUES ('kTCCServiceSystemPolicyAllFiles', '/opt/bin/node', 1, 2,");
    expect(OCU_REQUIREMENT).toContain('certificate leaf[subject.OU] = "CS54L4CF2Z"');
  });

  it("never put anything but a compiled requirement, or a plain name, in their SQL", () => {
    const row = { service: "kTCCServiceAccessibility", client: "a", clientType: 0 as const };
    expect(() => tccSql([{ ...row, csreq: "00'); DROP TABLE access; --" }])).toThrow();
    expect(() => tccSql([{ ...row, client: "a'); --", csreq: "00" }])).toThrow();
  });

  it("check the apps they download against their developers' signatures", () => {
    expect(BOOTSTRAP_SH).toContain(
      `codesign --verify --deep --strict -R='${OCU_REQUIREMENT}' "$root/ocu/OpenComputerUse.app"`,
    );
    expect(BOOTSTRAP_SH).toMatch(/-R='identifier "com\.google\.Chrome"[^']*EQHXZ8M8AV"'/);
    expect(BOOTSTRAP_SH).toContain("shasum -a 256 -c -");
  });

  it("say each step to the host while it's made, and stop at one that fails", () => {
    expect(BOOTSTRAP_SH).toContain("trap failed EXIT");
    expect(BOOTSTRAP_SH).toContain('tell "failed: $step');
    // Every step after the bootstrap's start says what it is.
    expect(BOOTSTRAP_SH.match(/^\s+say "/gm)?.length).toBeGreaterThanOrEqual(6);
  });

  it("build Tailscale without a C compiler, which a fresh macOS hasn't got", () => {
    expect(BOOTSTRAP_SH).toContain("CGO_ENABLED=0");
  });
});
