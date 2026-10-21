import { claudeHarness } from "@nibblets/harness-claude";
import { codexHarness } from "@nibblets/harness-codex";
import { deepseekHarness } from "@nibblets/harness-deepseek";
import { kimiHarness } from "@nibblets/harness-kimi";
import { opencodeHarness } from "@nibblets/harness-opencode";
import type { HarnessPlugin } from "@nibblets/harness";
import type { HarnessId } from "@nibblets/protocol";

/** Every harness a runner can be. */
export const plugins: Record<HarnessId, HarnessPlugin> = {
  claude: claudeHarness,
  codex: codexHarness,
  deepseek: deepseekHarness,
  kimi: kimiHarness,
  opencode: opencodeHarness,
};
