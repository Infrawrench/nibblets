import { describe, expect, it } from "vitest";
import { BOOTSTRAP_SH, OCU_REQUIREMENT, OCU_SERVICES, tccSql } from "../src/provision.ts";

describe("macOS guests' images", () => {
  it("let OpenComputerUse see and drive windows, when its developer signed it", () => {
    const sql = tccSql("fade0c00");
    for (const service of OCU_SERVICES) {
      expect(sql).toContain(`VALUES ('${service}', 'com.infrawrench.opencomputeruse', 0, 2,`);
    }
    expect(sql).toContain("X'fade0c00'");
    expect(OCU_REQUIREMENT).toContain('certificate leaf[subject.OU] = "CS54L4CF2Z"');
  });

  it("never put anything but a compiled requirement in their SQL", () => {
    expect(() => tccSql("00'); DROP TABLE access; --")).toThrow();
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
