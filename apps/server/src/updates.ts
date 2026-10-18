import {
  cliHarnesses,
  compareVersions,
  harnesses,
  HarnessId,
  latestRelease,
  type AppRelease,
  type AppUpdate,
  type HarnessUpdates,
} from "@nibblet/protocol";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";

const CHECK_EVERY_MS = 6 * 60 * 60_000;
const AUTO_SETTING = "harnessUpdates.auto";

// Only harnesses with a CLI of their own are listed.
const Versions = z.partialRecord(
  HarnessId,
  z.object({ bundled: z.string(), installed: z.string().nullable() }),
);
type Versions = z.infer<typeof Versions>;

/** The newest release of an npm package. */
export async function latestOnNpm(pkg: string, fetcher: typeof fetch = fetch): Promise<string> {
  const name = encodeURIComponent(pkg).replace(/^%40/, "@");
  const res = await fetcher(`https://registry.npmjs.org/${name}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`npm said ${res.status} for ${pkg}`);
  return z.object({ version: z.string() }).parse(await res.json()).version;
}

/**
 * Keeps the harnesses' CLIs (Claude Code, Codex, OpenCode) current without
 * rebuilding the runner image. Newer releases go into a shared volume that
 * runners mount read-only and prefer over their bundled CLI, from their next
 * turn. It checks npm every few hours and, unless that's turned off, installs
 * what's new by itself.
 */
export class HarnessUpdater {
  private versions: Versions | null = null;
  private readonly latest = new Map<HarnessId, string>();
  private readonly errors = new Map<HarnessId, string>();
  private readonly updating = new Set<HarnessId>();
  private checkedAt: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  private readonly deps: {
    store: Pick<Store, "getSetting" | "setSetting">;
    docker: Pick<Orchestrator, "harnessCli">;
    fetch?: typeof fetch;
    log?: (message: string) => void;
  };

  constructor(deps: HarnessUpdater["deps"]) {
    this.deps = deps;
  }

  start(): void {
    const tick = () => void this.tick();
    this.first = setTimeout(tick, 60_000);
    this.timer = setInterval(tick, CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  async auto(): Promise<boolean> {
    return this.deps.store.getSetting(AUTO_SETTING, (v) => z.boolean().parse(v), true);
  }

  async setAuto(auto: boolean): Promise<HarnessUpdates> {
    await this.deps.store.setSetting(AUTO_SETTING, auto);
    if (auto) void this.tick();
    return this.status();
  }

  async status(): Promise<HarnessUpdates> {
    if (!this.versions) await this.loadVersions();
    return {
      auto: await this.auto(),
      checkedAt: this.checkedAt,
      harnesses: cliHarnesses.map((id) => ({
        id,
        label: harnesses[id].cli.name,
        bundled: this.versions?.[id]?.bundled ?? null,
        installed: this.versions?.[id]?.installed ?? null,
        latest: this.latest.get(id) ?? null,
        updating: this.updating.has(id),
        error: this.errors.get(id) ?? null,
      })),
    };
  }

  /** Looks up the newest release of each harness's CLI. */
  async check(): Promise<HarnessUpdates> {
    await Promise.all(
      cliHarnesses.map(async (id) => {
        try {
          this.latest.set(id, await latestOnNpm(harnesses[id].cli.package, this.deps.fetch));
          if (!this.updating.has(id)) this.errors.delete(id);
        } catch (err) {
          this.errors.set(id, `Couldn't check for updates: ${message(err)}`);
        }
      }),
    );
    this.checkedAt = new Date().toISOString();
    await this.loadVersions();
    return this.status();
  }

  /**
   * Installs the newest release of one harness's CLI, or of every one that's
   * behind. Returns at once; installs run one at a time in the background.
   */
  async update(only?: HarnessId): Promise<HarnessUpdates> {
    if (this.latest.size === 0) await this.check();
    for (const id of only ? [harnesses[only].cliOf ?? only] : cliHarnesses) {
      const latest = this.latest.get(id);
      if (!latest || this.updating.has(id) || !this.behind(id, latest)) continue;
      this.updating.add(id);
      this.errors.delete(id);
      this.queue = this.queue.then(() => this.install(id, latest));
    }
    return this.status();
  }

  /** Goes back to the CLI in the runner image. */
  async useBundled(id: HarnessId): Promise<HarnessUpdates> {
    const own = harnesses[id].cliOf ?? id;
    await this.exclusively(() => this.deps.docker.harnessCli(["bundled", own]));
    await this.loadVersions();
    return this.status();
  }

  private behind(id: HarnessId, latest: string): boolean {
    const v = this.versions?.[id];
    const inUse = v?.installed ?? v?.bundled;
    return !inUse || compareVersions(latest, inUse) > 0;
  }

  private async install(id: HarnessId, version: string): Promise<void> {
    try {
      this.deps.log?.(`updating ${harnesses[id].cli.package} to ${version}`);
      await this.deps.docker.harnessCli(["install", id, version]);
      await this.loadVersions();
    } catch (err) {
      this.errors.set(id, `Couldn't install ${version}: ${message(err)}`);
    } finally {
      this.updating.delete(id);
    }
  }

  /** Runs after any install in progress, so two never write the volume at once. */
  private exclusively<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadVersions(): Promise<void> {
    try {
      this.versions = Versions.parse(await this.deps.docker.harnessCli(["versions"], 60_000));
    } catch (err) {
      this.deps.log?.(`couldn't read harness versions: ${message(err)}`);
    }
  }

  private async tick(): Promise<void> {
    await this.check();
    if (await this.auto()) await this.update();
  }
}

/** How long after asking for an update the server stops expecting it to restart it. */
const UPDATE_GIVE_UP_MS = 3 * 60_000;

const BridgeUpdate = z.object({
  method: z.enum(["here", "download", "manual"]),
  updating: z.boolean().default(false),
  error: z.string().nullable().default(null),
  progress: z.number().min(0).max(1).nullable().default(null),
});

/**
 * Whether a newer Nibblets is out: the latest GitHub release against this
 * server's version. Installing it is the host's job, since it means new
 * images and a restart; the host bridge says whether it can (a Linux install
 * can; the desktop app is a new download).
 */
export class AppUpdater {
  private latest: AppRelease | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private applying = false;
  private appliedAt = 0;

  private readonly deps: {
    config: Pick<Config, "HOST_MCP_URL" | "HOST_MCP_TOKEN" | "NIBBLET_UPDATE_REPO">;
    version: string;
    fetch?: typeof fetch;
    /** Holds the nibblets' work over the restart an update brings (Conductor.pauseForUpdate). */
    pause?: () => Promise<void>;
    /** Lets them carry on when the update doesn't happen. */
    unpause?: () => Promise<void>;
    now?: () => number;
  };

  constructor(deps: AppUpdater["deps"]) {
    this.deps = deps;
  }

  async status(refresh = false): Promise<AppUpdate> {
    const stale = !this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 60 * 60_000;
    if (refresh || stale) await this.check();
    const bridge = await this.bridge("GET");
    if (this.applying && bridge && !bridge.updating && this.updateFailed(bridge.error)) {
      // It failed, or the host came back without it: the nibblets carry on.
      this.applying = false;
      await this.deps.unpause?.();
    }
    const available =
      this.latest !== null && compareVersions(this.latest.version, this.deps.version) > 0;
    return {
      current: this.deps.version,
      latest: this.latest,
      available,
      method: bridge?.method ?? "manual",
      updating: this.applying || (bridge?.updating ?? false),
      progress: bridge?.updating ? bridge.progress : null,
      error: bridge?.error ?? this.error,
      checkedAt: this.checkedAt,
    };
  }

  /** Asks the host to install the latest release. The server restarts partway through. */
  async apply(): Promise<AppUpdate> {
    const status = await this.status();
    if (!status.available || !this.latest) throw new Error("There's nothing newer to install");
    if (status.method !== "here") throw new Error("This computer can't update itself from here");
    await this.deps.pause?.();
    const res = await this.bridge("POST", { version: this.latest.version });
    if (!res) {
      await this.deps.unpause?.();
      throw new Error("The host bridge didn't take the update");
    }
    this.applying = true;
    this.appliedAt = this.now();
    return this.status();
  }

  /**
   * Whether an update the host isn't working on any more has come to nothing:
   * it says why, or a while on, this server is still here on its old
   * version. (A Mac app that was reopened mid-install comes back without it,
   * and nothing restarts the server to clear this.)
   */
  private updateFailed(error: string | null): boolean {
    return error !== null || this.now() - this.appliedAt > UPDATE_GIVE_UP_MS;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async check(): Promise<void> {
    try {
      // Null with no releases yet, or while the repository isn't public: nothing to offer.
      this.latest = await latestRelease(this.deps.config.NIBBLET_UPDATE_REPO, this.deps.fetch);
      this.error = null;
      this.checkedAt = new Date().toISOString();
    } catch (err) {
      this.error = `Couldn't check for updates: ${message(err)}`;
    }
  }

  private async bridge(
    method: "GET" | "POST",
    body?: { version: string },
  ): Promise<z.infer<typeof BridgeUpdate> | null> {
    const { HOST_MCP_URL, HOST_MCP_TOKEN } = this.deps.config;
    if (!HOST_MCP_URL) return null;
    try {
      const res = await (this.deps.fetch ?? fetch)(`${HOST_MCP_URL}/update`, {
        method,
        headers: {
          authorization: `Bearer ${HOST_MCP_TOKEN}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return BridgeUpdate.parse(await res.json());
    } catch {
      return null;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
