import type { CliPlugin } from "./cli.ts";
import { ghPlugin } from "./gh.ts";
import { sshPlugin } from "./ssh.ts";

export * from "./cli.ts";
export * from "./gh.ts";
export * from "./ssh.ts";

/** Every CLI whose login can be shared. Add new plugins here. */
export const cliPlugins: readonly CliPlugin[] = [ghPlugin, sshPlugin];
