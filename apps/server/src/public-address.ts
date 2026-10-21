import { ProxyUrl, type PublicAddress } from "@nibblets/protocol";
import type { Store } from "./store.ts";
import type { Tunnel } from "./tunnel.ts";

/** The person's reverse proxy's address, if the server is behind one. */
const SETTING = "publicProxy";

export interface PublicAddressDeps {
  store: Pick<Store, "getSetting" | "setSetting" | "deleteSetting">;
  /** Linking to Nibblets Connect runs it, which reaches this server from the internet. */
  tunnel: Pick<Tunnel, "current">;
}

/**
 * How this server is reached from the internet, for anything that has to
 * be: the person's own reverse proxy if they've said it's behind one, else
 * Nibblets Connect's tunnel while it's up, else nothing.
 */
export class PublicAddresses {
  private readonly deps: PublicAddressDeps;

  constructor(deps: PublicAddressDeps) {
    this.deps = deps;
  }

  async current(): Promise<PublicAddress> {
    const proxy = await this.deps.store.getSetting(
      SETTING,
      (v) => ProxyUrl.nullable().parse(v),
      null,
    );
    if (proxy) return { url: proxy, via: "proxy", proxy };
    const tunnel = this.deps.tunnel.current();
    if (tunnel.state === "up" && tunnel.url) {
      return {
        url: tunnel.url.replace(/\/+$/, ""),
        via: tunnel.mode === "quick" ? "quick_tunnel" : "tunnel",
        proxy: null,
      };
    }
    return { url: null, via: null, proxy: null };
  }

  /** Says this server is behind a reverse proxy at `url`, or (null) that it isn't. */
  async setProxy(url: string | null): Promise<PublicAddress> {
    if (url) await this.deps.store.setSetting(SETTING, url);
    else await this.deps.store.deleteSetting(SETTING);
    return this.current();
  }
}
