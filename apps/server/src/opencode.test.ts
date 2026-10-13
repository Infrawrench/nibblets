import { Nibblet } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import { HarnessModelLists } from "./opencode.ts";

const config = loadConfig({
  NIBBLET_OWNER_TOKEN: "owner-token-0123456789",
  CREDPROXY_KEY: "credproxy-key-0123456789",
  CREDPROXY_ADMIN_KEY: "credproxy-admin-0123456789",
});
const noDocker: Pick<Orchestrator, "runOnce"> = {
  runOnce: () => Promise.reject(new Error("no docker in tests")),
};

describe("HarnessModelLists", () => {
  const lists = new HarnessModelLists(config, noDocker);

  it("serves the fixed lists for Claude and Codex", async () => {
    const claude = await lists.list("claude");
    expect(claude.state).toBe("ready");
    expect(claude.models.map((m) => m.id)).toContain("claude-opus-5-5");
    expect(await lists.accepts("codex", "gpt-5.6-terra")).toBe(true);
    expect(await lists.accepts("claude", "gpt-5.6-terra")).toBe(false);
  });

  it("says why OpenCode's list is missing, and still takes provider/model ids", async () => {
    const opencode = await lists.list("opencode");
    expect(opencode).toMatchObject({ state: "unavailable", models: [] });
    expect(await lists.accepts("opencode", "opencode/big-pickle")).toBe(true);
    expect(await lists.accepts("opencode", "big-pickle")).toBe(false);
  });

  it("never puts the host's OpenCode login in a nibblet the API returns", () => {
    expect(Object.keys(Nibblet.shape)).not.toContain("opencodeLogin");
  });
});
