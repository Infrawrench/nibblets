import { mkdir } from "node:fs/promises";
import path from "node:path";
import { query, type McpServerConfig, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  defineHarness,
  packageVersion,
  type HarnessContext,
  type McpServerSpec,
} from "@nibblet/harness";
import type { Effort } from "@nibblet/protocol";
import { ClaudeMapper } from "./mapper.ts";

export { ClaudeMapper } from "./mapper.ts";

/** Claude tops out at `max`; nibblet's `ultra` is a Codex level. */
function effortFor(effort: Effort): NonNullable<Options["effort"]> {
  return effort === "ultra" ? "max" : effort;
}

function mcpFor(spec: McpServerSpec): McpServerConfig {
  if (spec.type === "http") return { type: "http", url: spec.url, headers: spec.headers };
  return { type: "stdio", command: spec.command, args: spec.args, env: spec.env };
}

/**
 * Everything Claude Code needs to run against the credential proxy. The
 * proxy key goes in `ANTHROPIC_API_KEY`, which Claude Code sends as
 * `x-api-key`; the proxy checks it, drops it, and adds the real OAuth bearer.
 */
export function claudeEnv(ctx: HarnessContext, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    ...env,
    ANTHROPIC_BASE_URL: `${ctx.credproxyUrl}/anthropic`,
    ANTHROPIC_API_KEY: ctx.credproxyKey,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export const claudeHarness = defineHarness({
  id: "claude",
  version: () =>
    `claude-agent-sdk ${packageVersion(import.meta.resolve("@anthropic-ai/claude-agent-sdk"), "@anthropic-ai/claude-agent-sdk")}`,
  async open(ctx) {
    const configDir = path.join(ctx.workdir, ".claude");
    await mkdir(configDir, { recursive: true });
    let sessionId = ctx.config.resumeSessionId;
    const mcpServers = Object.fromEntries(
      Object.entries(ctx.mcpServers).map(([name, spec]) => [name, mcpFor(spec)]),
    );

    return {
      async run(turn, out) {
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        turn.signal.addEventListener("abort", onAbort, { once: true });
        const mapper = new ClaudeMapper(out);

        const options: Options = {
          abortController: abort,
          cwd: ctx.workdir,
          model: ctx.config.model,
          effort: effortFor(ctx.config.effort),
          systemPrompt: { type: "preset", preset: "claude_code", append: turn.system },
          // The container is the sandbox; nobody is there to approve prompts.
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          mcpServers,
          includePartialMessages: true,
          settingSources: [],
          env: claudeEnv(ctx, configDir),
          stderr: (data) => ctx.log("debug", data.trimEnd()),
          ...(sessionId ? { resume: sessionId } : {}),
        };

        try {
          for await (const msg of query({ prompt: turn.input, options })) {
            mapper.handle(msg);
          }
        } catch (err) {
          if (!turn.signal.aborted) {
            mapper.state.error = err instanceof Error ? err.message : String(err);
          }
        } finally {
          turn.signal.removeEventListener("abort", onAbort);
          out.finish();
        }

        sessionId = mapper.state.sessionId ?? sessionId;
        const status = turn.signal.aborted
          ? "interrupted"
          : mapper.state.error || !mapper.state.finished
            ? "failed"
            : "completed";
        return {
          status,
          error:
            status === "failed" ? (mapper.state.error ?? "Claude exited without a result") : null,
          usage: mapper.state.usage,
          sessionId,
        };
      },
      async close() {},
    };
  },
});

export default claudeHarness;
