import { linux } from "./linux.ts";
import { macos } from "./macos.ts";
import { windows } from "./windows.ts";
import type { EntryPlatform } from "./platform.ts";

/** The entry's platform here: Linux in containers and Linux VMs, the others in their VMs. */
export function platformHere(): EntryPlatform {
  switch (process.platform) {
    case "darwin":
      return macos;
    case "win32":
      return windows;
    default:
      return linux;
  }
}
