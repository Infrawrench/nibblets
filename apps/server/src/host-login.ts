import type { HarnessId, HostLogin } from "@nibblets/protocol";
import type { Bridge } from "./bridge.ts";
import { kimiLogin } from "./kimi.ts";
import { opencodeLogin } from "./opencode.ts";

type Fetch = (
  config: Bridge,
  model: string,
  warn: (m: string) => void,
) => Promise<HostLogin | null>;

/** The harnesses that borrow a host login; adding one is a line here and its harness package. */
const readers: Partial<Record<HarnessId, Fetch>> = {
  opencode: async (config, model, warn) => {
    const login = await opencodeLogin(config, model, warn);
    return login && { config: login.config, secret: login.auth };
  },
  kimi: async (config, _model, warn) => {
    const login = await kimiLogin(config, warn);
    return login && { config: login.config, secret: login.token };
  },
};

/** The host login `harness` runs on, fetched fresh, or null when it has none or none is shared. */
export async function hostLoginFor(
  config: Bridge,
  harness: HarnessId,
  opts: { model: string; warn: (message: string) => void },
): Promise<HostLogin | null> {
  return (await readers[harness]?.(config, opts.model, opts.warn)) ?? null;
}
