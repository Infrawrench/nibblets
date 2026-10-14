import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { HARNESS_CLI_DIR, harnesses, type HarnessId } from "@nibblet/protocol";

/**
 * The newer CLI the server installed for this harness, resolved to the real
 * file so an update mid-turn can't swap it underneath, or null to use the
 * one bundled with the SDK. Looked up afresh each time, so a new install is
 * picked up on the next turn.
 */
export function installedCli(id: HarnessId, root: string = HARNESS_CLI_DIR): string | null {
  const bin = path.join(root, id, "current", "node_modules", ".bin", harnesses[id].cli.bin);
  try {
    accessSync(bin, constants.X_OK);
    return realpathSync(bin);
  } catch {
    return null;
  }
}

/**
 * The folder of commands for the newer CLI, for harnesses that find theirs on
 * PATH. Resolved through `current`, so it stays put if that moves on.
 */
export function installedCliDir(id: HarnessId, root: string = HARNESS_CLI_DIR): string | null {
  if (!installedCli(id, root)) return null;
  try {
    return path.join(realpathSync(path.join(root, id, "current")), "node_modules", ".bin");
  } catch {
    return null;
  }
}
