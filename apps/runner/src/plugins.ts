import { claudeHarness } from "@nibblet/harness-claude";
import { codexHarness } from "@nibblet/harness-codex";
import { kimiHarness } from "@nibblet/harness-kimi";
import { opencodeHarness } from "@nibblet/harness-opencode";
import type { HarnessPlugin } from "@nibblet/harness";
import type { HarnessId } from "@nibblet/protocol";

/** Every harness a runner can be. */
export const plugins: Record<HarnessId, HarnessPlugin> = {
  claude: claudeHarness,
  codex: codexHarness,
  kimi: kimiHarness,
  opencode: opencodeHarness,
};
