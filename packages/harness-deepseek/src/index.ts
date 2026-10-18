import { claudeCodeHarness } from "@nibblet/harness-claude";
import { harnesses, type Effort, type RunnerConfig } from "@nibblet/protocol";

/** Where the credential proxy sends DeepSeek traffic, adding the API key. */
export const DEEPSEEK_ROUTE = "/deepseek";

/** The model Claude Code's background work (titles, summaries) runs on. */
const SMALL_MODEL = "deepseek-flash";

/**
 * The effort to ask for: the nibblet's own, when its model declares that
 * level. Otherwise DeepSeek picks, since it would refuse one it doesn't take.
 */
export function deepseekEffort(config: RunnerConfig): Effort | undefined {
  const model = harnesses.deepseek.models.find((m) => m.id === config.model);
  return model?.efforts.includes(config.effort) ? config.effort : undefined;
}

/**
 * Claude Code on DeepSeek's Anthropic-compatible API. It's the Claude
 * harness, sent to the proxy's DeepSeek route instead, which swaps the
 * runner's key for the user's DeepSeek API key.
 */
export const deepseekHarness = claudeCodeHarness({
  id: "deepseek",
  route: DEEPSEEK_ROUTE,
  effort: (config) => {
    const effort = deepseekEffort(config);
    // Claude Code's own levels; `ultra` is never one a DeepSeek model declares.
    return effort === "ultra" ? undefined : effort;
  },
  // Flash looks at images; V4 Pro takes text only, so it gets their paths.
  seesImages: (model) => model === SMALL_MODEL,
  env: {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: SMALL_MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: SMALL_MODEL,
  },
});

export default deepseekHarness;
