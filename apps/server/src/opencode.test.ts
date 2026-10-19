import { harnesses, Nibblet } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import { HarnessModelLists, scopeOpencodeAuth } from "./opencode.ts";

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
    expect(harnesses.codex.defaultModel).toBe("gpt-5.6-terra");
  });

  it("says why OpenCode's list is missing, and still takes provider/model ids", async () => {
    const opencode = await lists.list("opencode");
    expect(opencode).toMatchObject({ state: "unavailable", models: [] });
    expect(await lists.accepts("opencode", "opencode/big-pickle")).toBe(true);
    expect(await lists.accepts("opencode", "big-pickle")).toBe(false);
  });

  it.each([
    ["gpt-6.1-sol", "GPT-6.1 Sol", "Latest coding model", true],
    ["gpt-6-astra", "GPT-6 Astra", "For demanding work", true],
    ["gpt-6-sol", "GPT-6 Sol", "Coding and everyday work", true],
    ["gpt-5.6-sol", "GPT-5.6 Sol", "Previous coding model", undefined],
  ])("lists and accepts %s for Codex only", async (id, label, description, isNew) => {
    const codex = await lists.list("codex");
    expect(codex.models.find((model) => model.id === id)).toEqual({
      id,
      label,
      description,
      provider: "openai",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      ...(isNew ? { isNew } : {}),
    });
    expect(await lists.accepts("codex", id)).toBe(true);
    expect(await lists.accepts("claude", id)).toBe(false);
  });

  it("offers Kimi only once the host is signed in, but still knows its models", async () => {
    const kimi = await lists.list("kimi");
    expect(kimi).toMatchObject({ state: "unavailable", models: [] });
    expect(kimi.detail).toBeTruthy();
    expect(await lists.accepts("kimi", "kimi-code/k3")).toBe(true);
  });

  it("never puts the host's OpenCode login in a nibblet the API returns", () => {
    const keys = Object.keys(Nibblet.shape);
    for (const name of ["hostLogin", "opencodeLogin", "kimiLogin"])
      expect(keys).not.toContain(name);
  });
});

describe("scopeOpencodeAuth", () => {
  const auth = JSON.stringify({
    anthropic: { type: "oauth", access: "a" },
    "github-copilot": { type: "oauth", access: "g" },
    openrouter: { type: "api", key: "k" },
  });

  it("keeps only the login for the model's provider", () => {
    expect(JSON.parse(scopeOpencodeAuth(auth, "openrouter/qwen-3") ?? "null")).toEqual({
      openrouter: { type: "api", key: "k" },
    });
  });

  it("gives nothing when that provider has no login, or the input is odd", () => {
    expect(scopeOpencodeAuth(auth, "groq/llama")).toBeNull();
    expect(scopeOpencodeAuth(auth, "")).toBeNull();
    expect(scopeOpencodeAuth("not json", "openrouter/x")).toBeNull();
    expect(scopeOpencodeAuth(null, "openrouter/x")).toBeNull();
  });
});
