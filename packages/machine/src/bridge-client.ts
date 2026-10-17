import type { GuestOs } from "@nibblet/protocol";
import WebSocket from "ws";
import { z } from "zod";
import {
  Capacity,
  Console,
  HostMachines,
  VmInfo,
  type PrepareImage,
  type StartVm,
  type UpdateVm,
} from "./bridge-api.ts";
import type { GuestSocket } from "./guest-link.ts";

export interface BridgeAddress {
  /** `HOST_MCP_URL`: empty when there's no bridge, so no virtual machines. */
  url: string;
  token: string;
}

/** The bridge said no, or wasn't there. */
export class BridgeError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

const ErrorBody = z.object({ error: z.string() });

/**
 * One hypervisor on the host, through the host bridge's `/machines` API
 * (see bridge-api.ts). Long jobs (making an image) start here and are
 * watched through `host()`.
 */
export class HypervisorClient {
  readonly hypervisor: string;
  private readonly bridge: BridgeAddress;

  constructor(bridge: BridgeAddress, hypervisor: string) {
    this.bridge = bridge;
    this.hypervisor = hypervisor;
  }

  /** Whether there's a bridge to ask at all. */
  get configured(): boolean {
    return this.bridge.url !== "";
  }

  private path(rest: string): string {
    return `/machines/${encodeURIComponent(this.hypervisor)}${rest}`;
  }

  private async call<T>(
    schema: z.ZodType<T>,
    method: string,
    path: string,
    body?: object,
    timeoutMs = 60_000,
  ): Promise<T> {
    if (!this.bridge.url) {
      throw new BridgeError("There's no host bridge, so no virtual machines", null);
    }
    let res: Response;
    try {
      res = await fetch(`${this.bridge.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.bridge.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BridgeError(
        `Couldn't reach the host bridge: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    const raw: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const said = ErrorBody.safeParse(raw);
      throw new BridgeError(said.success ? said.data.error : `HTTP ${res.status}`, res.status);
    }
    return schema.parse(raw);
  }

  /** Every hypervisor on the host and its images; this one is found by id. */
  host(): Promise<HostMachines> {
    return this.call(HostMachines, "GET", "/machines", undefined, 20_000);
  }

  async prepare(guest: GuestOs, body: PrepareImage): Promise<void> {
    await this.call(z.unknown(), "POST", this.path(`/images/${guest}`), body);
  }

  vms(): Promise<VmInfo[]> {
    return this.call(z.array(VmInfo), "GET", this.path("/vms"), undefined, 20_000);
  }

  /** Boots it, making it first if it's new. Can take a while: disks get copied. */
  start(id: string, body: StartVm): Promise<VmInfo> {
    return this.call(VmInfo, "PUT", this.path(`/vms/${encodeURIComponent(id)}`), body, 10 * 60_000);
  }

  stop(id: string, force: boolean): Promise<VmInfo> {
    return this.call(VmInfo, "POST", this.path(`/vms/${encodeURIComponent(id)}/stop`), { force });
  }

  update(id: string, body: UpdateVm): Promise<VmInfo> {
    return this.call(VmInfo, "PATCH", this.path(`/vms/${encodeURIComponent(id)}`), body);
  }

  async remove(id: string): Promise<void> {
    await this.call(z.unknown(), "DELETE", this.path(`/vms/${encodeURIComponent(id)}`));
  }

  async console(id: string): Promise<string> {
    return (await this.call(Console, "GET", this.path(`/vms/${encodeURIComponent(id)}/console`)))
      .text;
  }

  capacity(): Promise<Capacity> {
    return this.call(Capacity, "GET", this.path("/capacity"));
  }

  /** A WebSocket to its guest agent, through the bridge. */
  link(id: string): Promise<GuestSocket> {
    if (!this.bridge.url) {
      return Promise.reject(new BridgeError("There's no host bridge", null));
    }
    const url = `${this.bridge.url.replace(/^http/, "ws")}${this.path(`/vms/${encodeURIComponent(id)}/link`)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.bridge.token}` },
        perMessageDeflate: false,
        // Its upgrade asks the hypervisor first, which can hang; this mustn't, with others waiting.
        handshakeTimeout: 30_000,
      });
      ws.once("open", () => resolve(wsSocket(ws)));
      ws.once("unexpected-response", (_req, res) => {
        reject(new BridgeError(`The bridge said ${res.statusCode}`, res.statusCode ?? null));
        ws.terminate();
      });
      ws.once("error", (err) => reject(new BridgeError(err.message, null)));
    });
  }
}

/** A `ws` WebSocket as a GuestSocket. */
export function wsSocket(ws: WebSocket): GuestSocket {
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage: (handler) =>
      ws.on("message", (data, isBinary) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        handler(isBinary ? bytes : bytes.toString("utf8"));
      }),
    onClose: (handler) => ws.on("close", handler),
    pause: () => ws.pause(),
    resume: () => ws.resume(),
  };
}
