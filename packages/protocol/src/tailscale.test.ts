import { describe, expect, it } from "vitest";
import { MASKED } from "./mcp.ts";
import { GATE_PORT, VIEW_PORT } from "./runner.ts";
import {
  mergeTailscale,
  NibbletTailscale,
  RESERVED_TAILNET_PORTS,
  tailnetHostname,
} from "./tailscale.ts";

describe("a nibblet's Tailscale settings", () => {
  it("keeps the container's own ports, and sub-agents' range, off the tailnet", () => {
    expect(RESERVED_TAILNET_PORTS).toContain(GATE_PORT);
    expect(RESERVED_TAILNET_PORTS).toContain(VIEW_PORT);
    for (const port of [GATE_PORT, VIEW_PORT, 7800, 1055, 20_000, 40_000, 0]) {
      expect(NibbletTailscale.safeParse({ authKey: "k", ports: [port] }).success).toBe(false);
    }
    expect(NibbletTailscale.parse({ authKey: "k", ports: [8080, 3000, 3000] }).ports).toEqual([
      3000, 8080,
    ]);
  });

  it("takes machine names Tailscale won't change", () => {
    expect(NibbletTailscale.safeParse({ authKey: "k", hostname: "pip-2" }).success).toBe(true);
    for (const hostname of ["Pip", "-pip", "pip_2", "pip.local"]) {
      expect(NibbletTailscale.safeParse({ authKey: "k", hostname }).success).toBe(false);
    }
  });

  it("makes a machine name from the nibblet's", () => {
    expect(tailnetHostname("Flight Watcher")).toBe("flight-watcher");
    expect(tailnetHostname("Crème brûlée!")).toBe("creme-brulee");
    expect(tailnetHostname("🐹")).toBe("nibblet");
    expect(tailnetHostname("a".repeat(80))).toHaveLength(63);
  });

  it("keeps the stored key when the masked one comes back", () => {
    const stored = { authKey: "tskey-auth-old", hostname: "", ports: [] };
    expect(mergeTailscale({ ...stored, authKey: MASKED }, stored).authKey).toBe("tskey-auth-old");
    expect(mergeTailscale({ ...stored, authKey: " tskey-auth-new " }, stored).authKey).toBe(
      "tskey-auth-new",
    );
    expect(mergeTailscale({ ...stored, authKey: MASKED }, null).authKey).toBe("");
  });
});
