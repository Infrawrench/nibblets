import { shell } from "electron";

/** The kinds of address handed to the system: never file:, smb: or a custom scheme. */
export function isExternalSafe(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Opens a web or mail address in the person's own browser or mail app; anything else is dropped. */
export function openOutside(url: string): void {
  if (isExternalSafe(url)) void shell.openExternal(url);
}

/** Pages sign-in may pass through: Clerk's own, and the usual social sign-ins. */
const SIGN_IN_HOSTS = [
  /\.clerk\.accounts\.dev$/,
  /^clerk\./,
  /^accounts\.google\.com$/,
  /^github\.com$/,
  /^appleid\.apple\.com$/,
  /^login\.microsoftonline\.com$/,
];

/** Whether the main window may go to `target`: the UI's own origin, or a step of signing in. */
export function navigationAllowed(target: string, ui: string): boolean {
  try {
    const to = new URL(target);
    if (to.origin === new URL(ui).origin) return true;
    return to.protocol === "https:" && SIGN_IN_HOSTS.some((host) => host.test(to.hostname));
  } catch {
    return false;
  }
}
