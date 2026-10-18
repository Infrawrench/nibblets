import { z } from "zod";

export const HarnessId = z.enum(["claude", "codex", "deepseek", "kimi", "opencode"]);
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

/**
 * Who serves a model. For Claude and Codex it's whose subscription it bills
 * to, which is also which credential the proxy injects; for OpenCode it's
 * whichever provider the user's OpenCode is signed in to.
 */
export type Provider = string;

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  provider: Provider;
  /** Empty when the harness has no effort setting for it. */
  efforts: readonly Effort[];
  defaultEffort: Effort;
  isNew?: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  description: string;
  /** Empty for harnesses whose models are listed live (`dynamicModels`). */
  defaultModel: string;
  models: readonly ModelOption[];
  /** The models come from the host's own setup, through `harnesses.models`. */
  dynamicModels: boolean;
  /**
   * The npm package with the harness's CLI, and its command. The server
   * installs newer releases of it for runners, ahead of the one in the image.
   */
  cli: { name: string; package: string; bin: string };
  /**
   * Set when the harness runs another harness's CLI rather than its own, so
   * that one is installed and updated once, under the other harness.
   */
  cliOf?: HarnessId;
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

// The aliases Kimi Code's `/login` provisions on a managed account, as its
// config reference lists them. Only the K3 family declares effort levels.
const kimiModels = [
  {
    id: "kimi-code/k3",
    label: "K3",
    description: "Strongest Kimi model",
    provider: "kimi",
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
    isNew: true,
  },
  {
    id: "kimi-code/kimi-for-coding",
    label: "Kimi for Coding",
    description: "Balanced coding workhorse",
    provider: "kimi",
    efforts: [],
    defaultEffort: "medium",
  },
  {
    id: "kimi-code/kimi-for-coding-highspeed",
    label: "Kimi for Coding Highspeed",
    description: "Fast, and priced higher",
    provider: "kimi",
    efforts: [],
    defaultEffort: "medium",
  },
] as const satisfies readonly ModelOption[];

// DeepSeek's Anthropic-compatible API, which Claude Code drives. Only V4 Pro
// declares effort levels; Flash is the one that can look at images.
const deepseekModels = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Strongest DeepSeek model",
    provider: "deepseek",
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash",
    description: "Fast and cheap, and sees images",
    provider: "deepseek",
    efforts: [],
    defaultEffort: "medium",
  },
] as const satisfies readonly ModelOption[];

export const harnesses: Record<HarnessId, HarnessInfo> = {
  claude: {
    id: "claude",
    label: "Claude",
    description: "Claude Agent SDK, on your Claude subscription",
    defaultModel: "claude-opus-5-5",
    models: claudeModels,
    dynamicModels: false,
    cli: { name: "Claude Code", package: "@anthropic-ai/claude-code", bin: "claude" },
  },
  codex: {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex, on your ChatGPT subscription",
    defaultModel: "gpt-5.6-terra",
    models: codexModels,
    dynamicModels: false,
    cli: { name: "Codex", package: "@openai/codex", bin: "codex" },
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    description: "Claude Code on DeepSeek's API, with your DeepSeek API key",
    defaultModel: "deepseek-v4-pro",
    models: deepseekModels,
    dynamicModels: false,
    cli: { name: "Claude Code", package: "@anthropic-ai/claude-code", bin: "claude" },
    cliOf: "claude",
  },
  kimi: {
    id: "kimi",
    label: "Kimi Code",
    description: "Kimi Code CLI, on your Kimi subscription",
    defaultModel: "kimi-code/k3",
    models: kimiModels,
    dynamicModels: false,
    cli: { name: "Kimi Code", package: "@moonshot-ai/kimi-code", bin: "kimi" },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode, on the account it's signed in to on this machine",
    defaultModel: "",
    models: [],
    dynamicModels: true,
    cli: { name: "OpenCode", package: "opencode-ai", bin: "opencode" },
  },
};

/** The harnesses with a CLI of their own to install and update. */
export const cliHarnesses: readonly HarnessId[] = HarnessId.options.filter(
  (id) => harnesses[id].cliOf === undefined,
);

export function findModel(harness: HarnessId, model: string): ModelOption | undefined {
  return harnesses[harness].models.find((m) => m.id === model);
}

/**
 * OpenCode's models, as `opencode models` lists them for the host's login.
 * OpenCode has no effort setting, so these carry no efforts.
 */
export function opencodeModel(m: { id: string; provider: string; name: string }): ModelOption {
  return {
    id: m.id,
    label: m.name,
    description: m.provider,
    provider: m.provider,
    efforts: [],
    defaultEffort: "medium",
  };
}

export const HarnessModels = z.object({
  harness: HarnessId,
  /** `unavailable` when the live list couldn't be fetched; `detail` says why. */
  state: z.enum(["ready", "unavailable"]),
  detail: z.string().nullable(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      description: z.string(),
      provider: z.string(),
      efforts: z.array(Effort).readonly(),
      defaultEffort: Effort,
      isNew: z.boolean().optional(),
    }),
  ),
});
export type HarnessModels = z.infer<typeof HarnessModels>;
