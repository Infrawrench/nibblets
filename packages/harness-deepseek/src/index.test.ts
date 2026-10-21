import { describe, expect, it } from "vitest";
import type { RunnerConfig } from "@nibblets/protocol";
import { deepseekEffort, deepseekHarness } from "./index.ts";

const config = (model: string, effort: RunnerConfig["effort"]) =>
  ({ model, effort }) as RunnerConfig;

describe("deepseekHarness", () => {
  it("is its own harness on Claude Code", () => {
    expect(deepseekHarness.id).toBe("deepseek");
    expect(deepseekHarness.version()).toMatch(/^claude-agent-sdk /);
  });
});

describe("deepseekEffort", () => {
  it("passes a level the model declares", () => {
    expect(deepseekEffort(config("deepseek-v4-pro", "max"))).toBe("max");
    expect(deepseekEffort(config("deepseek-flash", "low"))).toBe("low");
  });

  it("leaves out a level the model doesn't take", () => {
    expect(deepseekEffort(config("deepseek-v4-pro", "medium"))).toBeUndefined();
  });

  it("leaves effort out for a model it doesn't know", () => {
    expect(deepseekEffort(config("deepseek-chat", "high"))).toBeUndefined();
  });
});
