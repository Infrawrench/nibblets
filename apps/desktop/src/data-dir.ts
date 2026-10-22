import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the app keeps its settings and stack. Electron names it after the
 * package, so renaming the scope to @nibblets in 0.4.0 moved it and upgraded
 * installs started afresh: asked again whether to run a server, and made new
 * database secrets that their existing database refuses. Pinned here so a
 * rename can't move it again; installs from before then keep their folder.
 */
export function dataDir(appData: string, exists: (path: string) => boolean = existsSync): string {
  const before = join(appData, "@nibblet", "desktop");
  return exists(join(before, "settings.json")) ? before : join(appData, "@nibblets", "desktop");
}
