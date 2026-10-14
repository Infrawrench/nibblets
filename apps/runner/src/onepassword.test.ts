import { GuardConfig } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { gatedSpecs } from "./guard.ts";

const base = GuardConfig.parse({ browser: false });
const browser = {
  type: "http" as const,
  url: "http://127.0.0.1:7800/mcp",
  headers: { authorization: "Bearer t" },
};

describe("onepassword tools", () => {
  it("are only offered when vaults are shared, with the token kept in the guard", () => {
    expect(gatedSpecs(base, null, "/op.ts").onepassword).toBeUndefined();
    const shared = {
      ...base,
      onePassword: { token: "ops_x", vaults: [{ name: "Shared", access: "read" as const }] },
    };
    const spec = gatedSpecs(shared, null, "/op.ts").onepassword;
    expect(spec?.type).toBe("stdio");
    if (spec?.type === "stdio") {
      expect(spec.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_x");
      expect(JSON.parse(spec.env.NIBBLET_ONEPASSWORD_VAULTS ?? "[]")).toEqual([
        { name: "Shared", access: "read" },
      ]);
    }
  });

  it("are told how to reach the browser for fill_login", () => {
    const shared = { ...base, onePassword: { token: "ops_x", vaults: [] } };
    const spec = gatedSpecs(shared, browser, "/op.ts").onepassword;
    expect(spec?.type === "stdio" && spec.env).toMatchObject({
      OCU_MCP_URL: "http://127.0.0.1:7800/mcp",
      OCU_MCP_AUTH: "Bearer t",
    });
  });

  it("puts the browser and the nibblet's own servers behind the gate too", () => {
    const specs = gatedSpecs(
      GuardConfig.parse({
        browser: true,
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { a: "b" } },
        ],
      }),
      browser,
      "/op.ts",
    );
    expect(Object.keys(specs).sort()).toEqual(["computer", "linear"]);
    expect(specs.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { a: "b" },
    });
  });
});
