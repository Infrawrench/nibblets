import type { HypervisorMeta } from "@nibblet/machine";

/** What the server knows of this plugin: it runs on the host, in the bridge. */
export const meta: HypervisorMeta = { id: "hyperv", name: "Hyper-V" };
