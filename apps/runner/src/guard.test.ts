import { GuardConfig } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { gatedLimits, gatedSpecs } from "./guard.ts";

describe("app links behind the gate", () => {
  it("are served under the link's name with their credentials, over a server of the same name", () => {
    const specs = gatedSpecs(
      GuardConfig.parse({
        browser: false,
        mcpServers: [
          { name: "infrawrench", type: "http", url: "https://old.example/mcp", headers: {} },
        ],
        appLinks: [
          {
            name: "infrawrench",
            url: "https://app.infrawrench.com/api/mcp",
            headers: { authorization: "Bearer iwa_1" },
          },
        ],
      }),
      null,
      "/op.ts",
    );
    expect(specs).toEqual({
      infrawrench: {
        type: "http",
        url: "https://app.infrawrench.com/api/mcp",
        headers: { authorization: "Bearer iwa_1" },
      },
    });
  });

  it("are limited to the tools their grant gives", () => {
    const config = GuardConfig.parse({
      browser: false,
      appLinks: [
        {
          name: "t3code",
          url: "https://t3.example/mcp",
          headers: {},
          tools: ["t3_thread_list", "t3_thread_read"],
        },
        { name: "infrawrench", url: "https://app.infrawrench.com/api/mcp", headers: {} },
      ],
    });
    expect(gatedLimits(config)).toEqual({
      t3code: { tools: ["t3_thread_list", "t3_thread_read"] },
      infrawrench: { tools: null },
    });
  });

  it("are none for a guard config from before there were any", () => {
    expect(gatedSpecs(GuardConfig.parse({ browser: false }), null, "/op.ts")).toEqual({});
  });
});
