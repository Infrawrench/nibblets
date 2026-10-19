import { TunnelConfig, type TunnelStatus } from "@nibblet/protocol";
import type Docker from "dockerode";
import type { Config } from "./config.ts";
import { isNotFound, type Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";

export const TUNNEL_IMAGE = "cloudflare/cloudflared:2026.10.0";
const NAME = "nibblet-tunnel";
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
// Poll fast while waiting for a quick URL, slowing towards the error retry if it never comes.
const STARTING_POLL_MS = 1000;
const HEALTHY_POLL_MS = 15_000;
const ERROR_RETRY_MS = 5000;
const DOCKER_TIMEOUT_MS = 30_000;

/** Docker's logs endpoint takes Unix seconds; without a usable start time, read the whole log. */
function unixSeconds(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

export class Tunnel {
  private status: TunnelStatus = { mode: "off", state: "off", url: null, detail: null };
  private generation = 0;
  private stopped = false;
  private applied: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = Promise.resolve();
  private startingPollMs = STARTING_POLL_MS;
  private quickUrl: { container: string; startedAt: string; url: string } | undefined;
  private readonly docker: Orchestrator;
  private readonly store: Store;
  private readonly config: Config;

  constructor(docker: Orchestrator, store: Store, config: Config) {
    this.docker = docker;
    this.store = store;
    this.config = config;
  }

  current(): TunnelStatus {
    return this.status;
  }

  publicUrl(): string {
    return this.status.state === "up" && this.status.url
      ? this.status.url
      : this.config.NIBBLET_PUBLIC_URL;
  }

  async restore(): Promise<void> {
    const generation = this.generation;
    const saved = await this.store.getSetting("tunnel", (v) => TunnelConfig.parse(v), {
      mode: "off",
    });
    if (this.active(generation)) await this.configure(saved);
  }

  async configure(config: TunnelConfig): Promise<TunnelStatus> {
    if (this.stopped) return this.status;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.startingPollMs = STARTING_POLL_MS;
    const applied = JSON.stringify(config);
    // Reconfiguring a healthy tunnel with the same config must not drop publicUrl() to the local URL.
    const unchanged = this.status.state === "up" && applied === this.applied;
    this.applied = applied;
    if (!unchanged) {
      this.status = {
        mode: config.mode,
        state: config.mode === "off" ? "off" : "starting",
        url: null,
        detail: null,
      };
    }
    await this.enqueue(async () => {
      if (!this.active(generation)) return;
      try {
        await this.store.setSetting("tunnel", config);
      } finally {
        await this.reconcile(config, generation);
      }
    });
    return this.status;
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
  }

  private active(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  private command(config: Exclude<TunnelConfig, { mode: "off" }>): string[] {
    return config.mode === "quick"
      ? ["tunnel", "--no-autoupdate", "--url", this.config.NIBBLET_INTERNAL_URL]
      : ["tunnel", "--no-autoupdate", "run", "--token", config.token];
  }

  private async reconcile(config: TunnelConfig, generation: number): Promise<void> {
    if (!this.active(generation)) return;
    try {
      let container = this.docker.docker.getContainer(NAME);
      let info: Docker.ContainerInspectInfo | undefined;
      try {
        info = await container.inspect({ abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      if (!this.active(generation)) return;
      if (
        info &&
        (config.mode === "off" ||
          JSON.stringify(info.Config.Cmd) !== JSON.stringify(this.command(config)))
      ) {
        await container.remove({
          force: true,
          abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
        });
        info = undefined;
      }
      if (!this.active(generation)) return;
      if (config.mode === "off") {
        this.status = { mode: "off", state: "off", url: null, detail: null };
        return;
      }
      if (!info) {
        await this.pull(generation);
        if (!this.active(generation)) return;
        container = await this.docker.docker.createContainer({
          name: NAME,
          Image: TUNNEL_IMAGE,
          Cmd: this.command(config),
          Labels: { "nibblet.managed": "true", "nibblet.role": "tunnel" },
          HostConfig: {
            NetworkMode: this.config.NIBBLET_NETWORK,
            RestartPolicy: { Name: "unless-stopped" },
          },
          abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
        });
      }
      if (!this.active(generation)) return;
      if (!info?.State.Running) {
        await container.start({ abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
        if (!this.active(generation)) return;
        info = await container.inspect({ abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS) });
      }
      if (!this.active(generation)) return;
      if (!info.State.Running) throw new Error("cloudflared isn't running");
      if (config.mode === "token") {
        this.status = {
          mode: "token",
          state: "up",
          url: `https://${config.hostname}`,
          detail: null,
        };
      } else {
        const previous = this.quickUrl;
        const sameRun =
          previous?.container === info.Id && previous.startedAt === info.State.StartedAt;
        if (!sameRun) {
          this.quickUrl = undefined;
          this.status = { mode: "quick", state: "starting", url: null, detail: null };
        }
        const logs = await container.logs({
          stdout: true,
          stderr: true,
          tail: 5000,
          since: unixSeconds(info.State.StartedAt),
          abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
        });
        if (!this.active(generation)) return;
        const url =
          logs.toString("utf8").match(QUICK_URL)?.at(-1) ?? (sameRun ? previous.url : null);
        if (url) this.quickUrl = { container: info.Id, startedAt: info.State.StartedAt, url };
        this.status = { mode: "quick", state: url ? "up" : "starting", url, detail: null };
      }
    } catch (err) {
      if (!this.active(generation)) return;
      this.status = {
        mode: config.mode,
        state: "error",
        url: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (this.active(generation) && (config.mode !== "off" || this.status.state === "error")) {
        let delay = this.status.state === "up" ? HEALTHY_POLL_MS : ERROR_RETRY_MS;
        if (this.status.state === "starting") {
          delay = this.startingPollMs;
          this.startingPollMs = Math.min(this.startingPollMs * 2, ERROR_RETRY_MS);
        } else {
          this.startingPollMs = STARTING_POLL_MS;
        }
        this.timer = setTimeout(() => {
          void this.enqueue(() => this.reconcile(config, generation));
        }, delay);
        this.timer.unref();
      }
    }
  }

  private async pull(generation: number): Promise<void> {
    const images = await this.docker.docker.listImages({
      filters: { reference: [TUNNEL_IMAGE] },
      abortSignal: AbortSignal.timeout(DOCKER_TIMEOUT_MS),
    });
    if (images.length > 0 || !this.active(generation)) return;
    const stream = await this.docker.docker.pull(TUNNEL_IMAGE, {
      abortSignal: AbortSignal.timeout(5 * 60_000),
    });
    await new Promise<void>((resolve, reject) =>
      this.docker.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
    );
  }
}
