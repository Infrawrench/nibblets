import type { HypervisorMeta } from "@nibblet/machine";

/** What the server knows of this plugin: it runs on the host, in the bridge. */
export const meta: HypervisorMeta = { id: "apple", name: "Apple Virtualization" };
