import { placeholderCodexAuth } from "@nibblet/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Codex, type ModelReasoningEffort, type ThreadOptions } from "@openai/codex-sdk";
import {
  defineHarness,
  inputWithAttachments,
  isModelImage,
  packageVersion,
  type HarnessContext,
  type McpServerSpec,
  installedCli,
  packageField,
} from "@nibblet/harness";
import type { Effort } from "@nibblet/protocol";
import { CodexMapper } from "./mapper.ts";

export { CodexMapper } from "./mapper.ts";

export { placeholderJwt } from "@nibblet/protocol";
export const placeholderAuth = placeholderCodexAuth;

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

function mcpFor(spec: McpServerSpec): { [key: string]: TomlValue } {
  if (spec.type === "http") return { url: spec.url, http_headers: spec.headers };
  return { command: spec.command, args: spec.args, env: spec.env };
}

function effortFor(effort: Effort): ModelReasoningEffort {
  return effort;
}

export function codexEnv(ctx: HarnessContext, codexHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return {
    ...env,
    CODEX_HOME: codexHome,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${ctx.credproxyUrl}/openai-auth/oauth/token`,
  };
}

export const codexHarness = defineHarness({
  id: "codex",
  version: () =>
    `codex-sdk ${packageVersion(import.meta.resolve("@openai/codex-sdk"), "@openai/codex-sdk")}`,
  bundledCli: () => {
    // The SDK pins the exact Codex it drives.
    const deps = packageField(
      import.meta.resolve("@openai/codex-sdk"),
      "@openai/codex-sdk",
      "dependencies",
    );
    const v =
      typeof deps === "object" && deps !== null
        ? Object.entries(deps).find(([k]) => k === "@openai/codex")?.[1]
        : undefined;
    return typeof v === "string" ? v : "unknown";
  },
  async open(ctx) {
    const codexHome = path.join(ctx.stateDir ?? ctx.workdir, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify(placeholderAuth(ctx.credproxyKey), null, 2),
      { mode: 0o600 },
    );
    let threadId = ctx.config.resumeSessionId;
    const mcpServers = Object.fromEntries(
      Object.entries(ctx.mcpServers).map(([name, spec]) => [name, mcpFor(spec)]),
    );
    const threadOptions: ThreadOptions = {
      model: ctx.config.model,
      modelReasoningEffort: effortFor(ctx.config.effort),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      workingDirectory: ctx.workdir,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
      webSearchMode: "live",
    };

    return {
      async run(turn, out) {
        // A Codex instance is only a wrapper around `codex exec`, so making one
        // per turn is cheap and lets each turn carry its own instructions.
        const cli = installedCli("codex");
        const codex = new Codex({
          // A newer Codex the server installed, else the one the SDK depends on.
          ...(cli ? { codexPathOverride: cli } : {}),
          baseUrl: `${ctx.credproxyUrl}/openai`,
          env: codexEnv(ctx, codexHome),
          config: {
            developer_instructions: turn.system,
            mcp_servers: mcpServers,
            cli_auth_credentials_store: "file",
            forced_login_method: "chatgpt",
            // Everything else Codex fetches from ChatGPT (plugins, connectors,
            // analytics) is off, and the base URL for it is the proxy, where
            // those paths 404. Sent straight to chatgpt.com with the
            // placeholder token, they 401, and a 401 makes Codex refresh.
            chatgpt_base_url: `${ctx.credproxyUrl}/chatgpt/`,
            features: {
              apps: false,
              enable_mcp_apps: false,
              plugins: false,
              remote_plugin: false,
              recommended_plugins: false,
              tool_suggest: false,
            },
            analytics: { enabled: false },
            check_for_update_on_startup: false,
            // A provider of our own, identical to the built-in one except that
            // it talks plain HTTP + SSE, so the proxy needn't relay WebSockets.
            model_provider: "nibblet",
            model_providers: {
              nibblet: {
                name: "ChatGPT (via nibblet)",
                base_url: `${ctx.credproxyUrl}/openai`,
                wire_api: "responses",
                requires_openai_auth: true,
                supports_websockets: false,
              },
            },
          },
        });
        const thread = threadId
          ? codex.resumeThread(threadId, threadOptions)
          : codex.startThread(threadOptions);
        const mapper = new CodexMapper(out);

        try {
          // Images go in as local images Codex can see; every file is named in the text.
          const text = inputWithAttachments(turn.input, turn.attachments);
          const images = (turn.attachments ?? []).filter((a) => isModelImage(a.mime));
          const input =
            images.length === 0
              ? text
              : [
                  { type: "text" as const, text },
                  ...images.map((a) => ({ type: "local_image" as const, path: a.path })),
                ];
          const { events } = await thread.runStreamed(input, { signal: turn.signal });
          for await (const event of events) mapper.handle(event);
        } catch (err) {
          if (!turn.signal.aborted) {
            mapper.state.error = err instanceof Error ? err.message : String(err);
          }
        } finally {
          out.finish();
        }

        threadId = mapper.state.threadId ?? thread.id ?? threadId;
        const status = turn.signal.aborted
          ? "interrupted"
          : mapper.state.error || !mapper.state.finished
            ? "failed"
            : "completed";
        return {
          status,
          error:
            status === "failed" ? (mapper.state.error ?? "Codex exited without finishing") : null,
          usage: mapper.state.usage,
          sessionId: threadId,
        };
      },
      async close() {},
    };
  },
});

export default codexHarness;
