import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostMachines, target, type HypervisorPlugin } from "@nibblet/machine/host";
import { AppleVirtualization } from "@nibblet/machine-apple";
import { HyperV } from "@nibblet/machine-hyperv";
import { Kvm } from "@nibblet/machine-kvm";

const run = promisify(execFile);

export interface HostMachinesConfig {
  /** Where VMs and their images live. */
  dir: string;
  /** The Docker CLI, which makes Linux images; found on PATH when not given. */
  docker?: string | null;
  /** Apple's VM helper, built and signed (the desktop app ships one); built here otherwise. */
  appleHelper?: string;
  /** The Hyper-V switch VMs go out through: the Default Switch, unless there isn't one (Windows Server). */
  hypervSwitch?: string;
  /** The nibblet server and the credential proxy, as this host reaches them. */
  server?: string;
  credproxy?: string;
  log?: (message: string) => void;
}

/** The hypervisor plugin for this OS: there's one of each, and only one fits. */
export function hypervisorsHere(
  config: Pick<HostMachinesConfig, "appleHelper" | "hypervSwitch">,
): HypervisorPlugin[] {
  switch (process.platform) {
    case "darwin":
      return [new AppleVirtualization(config.appleHelper ? { helper: config.appleHelper } : {})];
    case "win32":
      return [new HyperV(config.hypervSwitch ? { switch: config.hypervSwitch } : {})];
    case "linux":
      return [new Kvm()];
    default:
      return [];
  }
}

async function findDocker(): Promise<string | null> {
  const which = process.platform === "win32" ? "where" : "which";
  const out = await run(which, ["docker"]).then(
    (r) => r.stdout.trim().split(/\r?\n/)[0] ?? "",
    () => "",
  );
  return out || null;
}

/** Virtual machines on this host, for the bridge's `/machines` API. */
export async function hostMachines(config: HostMachinesConfig): Promise<HostMachines> {
  return new HostMachines({
    plugins: hypervisorsHere(config),
    dir: config.dir,
    docker: config.docker === undefined ? await findDocker() : config.docker,
    targets: {
      server: target(config.server ?? "http://127.0.0.1:8420"),
      credproxy: target(config.credproxy ?? "http://127.0.0.1:8787"),
    },
    ...(config.log ? { log: config.log } : {}),
  });
}
