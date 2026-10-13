import { z } from "zod";

export const HarnessId = z.enum(["claude", "codex", "opencode"]);
export type HarnessId = z.infer<typeof HarnessId>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type Effort = z.infer<typeof Effort>;

export const effortLabels: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** Whose subscription a model bills to, which is also which credential the proxy injects. */
export type Provider = "anthropic" | "openai";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  provider: Provider;
  efforts: readonly Effort[];
  defaultEffort: Effort;
  isNew?: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  description: string;
  defaultModel: string;
  models: readonly ModelOption[];
}

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const codexEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

const claudeModels = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    description: "Newest Claude model",
    provider: "anthropic",
    efforts: claudeEfforts,
    defaultEffort: "medium",
    isNew: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    description: "Most capable for long, hard work",
    provider: "anthropic",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    description: "Fast and capable",
    provider: "anthropic",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    description: "Quickest and cheapest",
    provider: "anthropic",
    efforts: claudeEfforts,
    defaultEffort: "low",
  },
] as const satisfies readonly ModelOption[];

const codexModels = [
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "Strongest Codex model",
    provider: "openai",
    efforts: [...codexEfforts, "ultra"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    description: "Fast and affordable",
    provider: "openai",
    efforts: codexEfforts,
    defaultEffort: "medium",
    isNew: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Previous fast model",
    provider: "openai",
    efforts: codexEfforts,
    defaultEffort: "medium",
  },
] as const satisfies readonly ModelOption[];

/** OpenCode drives either provider; its model ids are `provider/model`. */
const opencodeModels: readonly ModelOption[] = [...claudeModels, ...codexModels].map((m) => ({
  ...m,
  id: `${m.provider}/${m.id}`,
}));

export const harnesses: Record<HarnessId, HarnessInfo> = {
  claude: {
    id: "claude",
    label: "Claude",
    description: "Claude Agent SDK, on your Claude subscription",
    defaultModel: "claude-opus-5-5",
    models: claudeModels,
  },
  codex: {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex, on your ChatGPT subscription",
    defaultModel: "gpt-5.6-terra",
    models: codexModels,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode, with either subscription",
    defaultModel: "anthropic/claude-opus-5-5",
    models: opencodeModels,
  },
};

export function findModel(harness: HarnessId, model: string): ModelOption | undefined {
  return harnesses[harness].models.find((m) => m.id === model);
}
