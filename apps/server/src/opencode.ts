import {
  harnesses,
  opencodeModel,
  OpencodeLogin,
  type HarnessId,
  type HarnessModels,
} from "@nibblet/protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Orchestrator } from "./docker.ts";

const CACHE_MS = 60_000;

const HostOpencode = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  hasLogin: z.boolean(),
  detail: z.string().nullable(),
});

const ListedModels = z.object({
  models: z.array(z.object({ id: z.string(), provider: z.string(), name: z.string() })),
});

/** `provider/model`, which is all the server can check when the live list is out of reach. */
export const OPENCODE_MODEL_ID = /^[^\s/]+\/\S+$/;

type Bridge = Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN">;

async function bridgeGet(config: Bridge, path: string): Promise<unknown> {
  const res = await fetch(`${config.HOST_MCP_URL}${path}`, {
    headers: { authorization: `Bearer ${config.HOST_MCP_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The host's OpenCode login, fetched fresh for each runner configure. Null
 * without a bridge or a login, in which case OpenCode uses the proxy.
 */
export async function opencodeLogin(
  config: Bridge,
  warn: (message: string) => void,
): Promise<OpencodeLogin | null> {
  if (!config.HOST_MCP_URL) return null;
  try {
    const login = OpencodeLogin.parse(await bridgeGet(config, "/harness/opencode/login"));
    return login.config === null && login.auth === null ? null : login;
  } catch (err) {
    warn(
      `Couldn't fetch the host's OpenCode login: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Model lists for the picker. Claude and Codex have fixed lists; OpenCode's
 * is whatever `opencode models` gives for the host's login, run in a
 * throwaway runner container so it matches what a nibblet will see.
 */
export class HarnessModelLists {
  private cache: { key: string; at: number; result: Promise<HarnessModels> } | null = null;
  private readonly config: Config;
  private readonly docker: Pick<Orchestrator, "runOnce">;

  constructor(config: Config, docker: Pick<Orchestrator, "runOnce">) {
    this.config = config;
    this.docker = docker;
  }

  async list(harness: HarnessId): Promise<HarnessModels> {
    if (harness !== "opencode") {
      return { harness, state: "ready", detail: null, models: [...harnesses[harness].models] };
    }
    return this.opencode();
  }

  /** Whether `model` can be used with `harness`. */
  async accepts(harness: HarnessId, model: string): Promise<boolean> {
    if (harness !== "opencode") return harnesses[harness].models.some((m) => m.id === model);
    const live = await this.opencode();
    if (live.state === "ready") return live.models.some((m) => m.id === model);
    return OPENCODE_MODEL_ID.test(model);
  }

  private async opencode(): Promise<HarnessModels> {
    const unavailable = (detail: string): HarnessModels => ({
      harness: "opencode",
      state: "unavailable",
      detail,
      models: [],
    });
    if (!this.config.HOST_MCP_URL) return unavailable("The host bridge isn't set up");
    let host: z.infer<typeof HostOpencode>;
    try {
      host = HostOpencode.parse(await bridgeGet(this.config, "/harness/opencode"));
    } catch {
      return unavailable("The host bridge isn't connected");
    }
    if (!host.installed) return unavailable("OpenCode isn't installed on the host");
    const login = await opencodeLogin(this.config, () => {});
    if (!login) return unavailable(host.detail ?? "OpenCode isn't signed in on the host");

    // Keyed by the login, so signing in to another provider shows up at once.
    const key = createHash("sha256").update(JSON.stringify(login)).digest("hex");
    const now = Date.now();
    if (this.cache && this.cache.key === key && now - this.cache.at < CACHE_MS) {
      return this.cache.result;
    }
    const result = this.listInContainer(login).catch((err: unknown) =>
      unavailable(
        `Couldn't list OpenCode's models: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    this.cache = { key, at: now, result };
    const settled = await result;
    // Don't hold on to a failure for a whole minute.
    if (settled.state !== "ready" && this.cache?.result === result) this.cache = null;
    return settled;
  }

  private async listInContainer(login: OpencodeLogin): Promise<HarnessModels> {
    const run = await this.docker.runOnce(
      ["node", "/app/apps/runner/src/opencode-models.ts"],
      JSON.stringify(login),
    );
    if (run.code !== 0) throw new Error(run.stderr.trim().split("\n").pop() || `exit ${run.code}`);
    const { models } = ListedModels.parse(JSON.parse(run.stdout));
    return { harness: "opencode", state: "ready", detail: null, models: models.map(opencodeModel) };
  }
}
