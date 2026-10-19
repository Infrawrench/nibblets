import { defaultHamsterLook, MASKED } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { cliLogins } from "./clilogins.ts";
import { toNibblet } from "./store.ts";

const bridge = { HOST_MCP_URL: "http://bridge", HOST_MCP_TOKEN: "t" };

describe("cliLogins", () => {
  it("asks the bridge only for CLIs ticked for the nibblet", async () => {
    const asked: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      asked.push(String(input));
      return Response.json({ env: { GH_TOKEN: "gho_x" }, setup: [["gh", "auth", "setup-git"]] });
    };
    expect(await cliLogins(bridge, [], () => {}, fakeFetch)).toEqual([]);
    expect(asked).toEqual([]);
    const logins = await cliLogins(bridge, ["gh"], () => {}, fakeFetch);
    expect(asked).toEqual(["http://bridge/clis/gh/credential"]);
    expect(logins).toEqual([
      { id: "gh", env: { GH_TOKEN: "gho_x" }, setup: [["gh", "auth", "setup-git"]] },
    ]);
  });

  it("sends nothing without a bridge, and skips CLIs that refuse", async () => {
    const refuse: typeof fetch = async () =>
      Response.json({ error: "signed out" }, { status: 409 });
    expect(
      await cliLogins({ HOST_MCP_URL: "", HOST_MCP_TOKEN: "" }, ["gh"], () => {}, refuse),
    ).toEqual([]);
    const warnings: string[] = [];
    expect(await cliLogins(bridge, ["gh"], (w) => warnings.push(w), refuse)).toEqual([]);
    expect(warnings[0]).toContain("gh");
  });
});

describe("toNibblet", () => {
  it("masks MCP secrets and never carries CLI tokens", () => {
    const now = new Date();
    const nibblet = toNibblet({
      id: "nib_1",
      name: "Pip",
      look: defaultHamsterLook,
      harness: "claude",
      model: "claude-haiku-5-5",
      effort: "low",
      instructions: "",
      promptName: null,
      plain: false,
      parentId: null,
      status: "idle",
      statusDetail: null,
      resources: { cpus: null, memoryMb: null },
      monthlyBudgetUsd: null,
      snapshotPolicy: { everyMinutes: 1440, keep: 7 },
      heartbeats: [],
      toolApprovals: [],
      tailscale: { authKey: "tskey-auth-secret", hostname: "", ports: [3000] },
      tailnetNode: null,
      spendingLimits: [],
      statusText: null,
      statusEmoji: null,
      statusUpdatedAt: null,
      awaitingApproval: false,
      browser: false,
      hostTools: ["files"],
      cliCredentials: ["gh"],
      mcpServers: [
        {
          name: "linear",
          type: "http",
          url: "https://x.dev/mcp",
          headers: { authorization: "Bearer secret" },
        },
        { name: "gh2", type: "stdio", command: "npx", args: [], env: { TOKEN: "ghp_secret" } },
      ],
      tokenHash: "hash",
      containerId: null,
      harnessSessionId: null,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
    });
    const text = JSON.stringify(nibblet);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("hash");
    expect(nibblet.mcpServers[0]).toMatchObject({ headers: { authorization: MASKED } });
    expect(nibblet.cliCredentials).toEqual(["gh"]);
    expect(nibblet.tailscale).toEqual({ authKey: MASKED, hostname: "", ports: [3000] });
  });
});
