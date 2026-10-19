import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@nibblet/protocol";
import { hostLoginFor } from "./host-login.ts";

const bridge = { HOST_MCP_URL: "http://bridge.test", HOST_MCP_TOKEN: "t" };
const opts = { model: "opencode/big-pickle", warn: () => {} };

function stubBridge(logins: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const hit = Object.entries(logins).find(([path]) => url.endsWith(path));
    return new Response(JSON.stringify(hit?.[1] ?? {}), { status: hit ? 200 : 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("hostLoginFor", () => {
  it("gives OpenCode's config and auth as config and secret", async () => {
    stubBridge({ "/harness/opencode/login": { config: "{}", auth: null } });
    expect(await hostLoginFor(bridge, "opencode", opts)).toEqual({ config: "{}", secret: null });
  });

  it("gives Kimi's config and token as config and secret", async () => {
    stubBridge({ "/harness/kimi/login": { config: "a = 1", token: "tok" } });
    expect(await hostLoginFor(bridge, "kimi", opts)).toEqual({ config: "a = 1", secret: "tok" });
  });

  it("gives nothing for harnesses with no host login", async () => {
    stubBridge({
      "/harness/opencode/login": { config: "{}", auth: "{}" },
      "/harness/kimi/login": { config: "a = 1", token: "tok" },
    });
    for (const harness of ["claude", "codex", "deepseek"] as HarnessId[]) {
      expect(await hostLoginFor(bridge, harness, opts)).toBeNull();
    }
  });

  it("gives nothing without a host bridge", async () => {
    const none = { HOST_MCP_URL: "", HOST_MCP_TOKEN: "" };
    expect(await hostLoginFor(none, "kimi", opts)).toBeNull();
  });
});
