import { RunnerConfig } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { mcpServersFor, onePasswordServer } from "./runner.ts";

const base = RunnerConfig.parse({
  nibbletId: "nib_1",
  name: "Pip",
  harness: "claude",
  model: "claude-haiku-5-5",
  effort: "low",
  resumeSessionId: null,
});

describe("onepassword tools", () => {
  it("are only offered when vaults are shared", () => {
    const deps = {
      mcpServers: {},
      hostMcp: () => ({ type: "http" as const, url: "", headers: {} }),
    };
    expect(mcpServersFor(base, deps).onepassword).toBeUndefined();
    const shared = {
      ...base,
      cli: [
        {
          id: "1password",
          env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_x", NIBBLET_ONEPASSWORD_VAULTS: "[]" },
          setup: [],
        },
      ],
    };
    const spec = mcpServersFor(shared, deps).onepassword;
    expect(spec?.type).toBe("stdio");
    if (spec?.type === "stdio") expect(spec.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_x");
  });

  it("are told how to reach the browser for fill_login", () => {
    const spec = onePasswordServer(
      { OP_SERVICE_ACCOUNT_TOKEN: "ops_x" },
      { type: "http", url: "http://127.0.0.1:7800/mcp", headers: { authorization: "Bearer t" } },
    );
    expect(spec.type === "stdio" && spec.env).toMatchObject({
      OCU_MCP_URL: "http://127.0.0.1:7800/mcp",
      OCU_MCP_AUTH: "Bearer t",
    });
  });
});
