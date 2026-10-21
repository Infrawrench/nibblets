import type { HypervisorMeta } from "@nibblets/machine";

/** What the server knows of this plugin: it runs on the host, in the bridge. */
export const meta: HypervisorMeta = { id: "kvm", name: "KVM" };
