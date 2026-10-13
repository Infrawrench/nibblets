import { TunnelConfig, type TunnelStatus } from "@nibblet/protocol";
import type { Config } from "./config.ts";
import type { Orchestrator } from "./docker.ts";
import type { Store } from "./store.ts";

const IMAGE = "cloudflare/cloudflared:2026.10.0";
const NAME = "nibblet-tunnel";
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Runs cloudflared next to the server so it can be reached from anywhere.
 * The tunnel points at `server:8420` on the Docker network, so nothing has
 * to be published on the host.
 */
export class Tunnel {
  private status: TunnelStatus = { mode: "off", state: "off", url: null, detail: null };
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

  /** The address people should use, preferring the tunnel's. */
  publicUrl(): string {
    return this.status.state === "up" && this.status.url
      ? this.status.url
      : this.config.NIBBLET_PUBLIC_URL;
  }

  async restore(): Promise<void> {
    const saved = await this.store.getSetting("tunnel", (v) => TunnelConfig.parse(v), {
      mode: "off",
    });
    await this.apply(saved).catch((err: unknown) => console.error("tunnel restore failed", err));
  }

  async configure(config: TunnelConfig): Promise<TunnelStatus> {
    await this.store.setSetting("tunnel", config);
    return this.apply(config);
  }

  /** cloudflared's arguments for a config. */
  private command(config: Exclude<TunnelConfig, { mode: "off" }>): string[] {
    return config.mode === "quick"
      ? ["tunnel", "--no-autoupdate", "--url", this.config.NIBBLET_INTERNAL_URL]
      : ["tunnel", "--no-autoupdate", "run", "--token", config.token];
  }

  /**
   * Whether cloudflared is already running exactly this config. A server
   * restart then keeps the tunnel, and with a quick tunnel its address, rather
   * than handing out a new one.
   */
  private async alreadyRunning(cmd: string[]): Promise<boolean> {
    try {
      const info = await this.docker.docker.getContainer(NAME).inspect();
      return info.State.Running && JSON.stringify(info.Config.Cmd) === JSON.stringify(cmd);
    } catch {
      return false;
    }
  }

  private async apply(config: TunnelConfig): Promise<TunnelStatus> {
    if (config.mode !== "off" && (await this.alreadyRunning(this.command(config)))) {
      if (config.mode === "token") {
        this.status = {
          mode: "token",
          state: "up",
          url: `https://${config.hostname}`,
          detail: null,
        };
      } else {
        this.status = { mode: "quick", state: "starting", url: null, detail: null };
        void this.watchForQuickUrl();
      }
      return this.status;
    }
    await this.docker.removeContainer(NAME);
    if (config.mode === "off") {
      this.status = { mode: "off", state: "off", url: null, detail: null };
      return this.status;
    }
    this.status = { mode: config.mode, state: "starting", url: null, detail: null };
    try {
      await this.pull();
      const cmd = this.command(config);
      const container = await this.docker.docker.createContainer({
        name: NAME,
        Image: IMAGE,
        Cmd: cmd,
        Labels: { "nibblet.managed": "true", "nibblet.role": "tunnel" },
        HostConfig: {
          NetworkMode: this.config.NIBBLET_NETWORK,
          RestartPolicy: { Name: "unless-stopped" },
        },
      });
      await container.start();
      if (config.mode === "token") {
        this.status = {
          mode: "token",
          state: "up",
          url: `https://${config.hostname}`,
          detail: null,
        };
      } else {
        void this.watchForQuickUrl();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { mode: config.mode, state: "error", url: null, detail: message };
    }
    return this.status;
  }

  private async pull(): Promise<void> {
    const images = await this.docker.docker.listImages({ filters: { reference: [IMAGE] } });
    if (images.length > 0) return;
    const stream = await this.docker.docker.pull(IMAGE);
    await new Promise<void>((resolve, reject) =>
      this.docker.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
    );
  }

  /** Quick tunnels print their random address to the log once they connect. */
  private async watchForQuickUrl(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (this.status.mode !== "quick") return;
      const logs = await this.containerLogs();
      const url = QUICK_URL.exec(logs)?.[0];
      if (url) {
        this.status = { mode: "quick", state: "up", url, detail: null };
        return;
      }
    }
    this.status = {
      mode: "quick",
      state: "error",
      url: null,
      detail: "cloudflared didn't report an address",
    };
  }

  private async containerLogs(): Promise<string> {
    try {
      const buf = await this.docker.docker
        .getContainer(NAME)
        .logs({ stdout: true, stderr: true, tail: 5000 });
      return buf.toString("utf8");
    } catch {
      return "";
    }
  }
}
