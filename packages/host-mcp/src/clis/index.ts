import type { CliPlugin } from "./cli.ts";
import { ghPlugin } from "./gh.ts";

export * from "./cli.ts";
export * from "./gh.ts";

/** Every CLI whose login can be shared. Add new plugins here. */
export const cliPlugins: readonly CliPlugin[] = [ghPlugin];
