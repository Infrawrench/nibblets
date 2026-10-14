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

/** Clerk's own pages, which sign-in may pass through in the window. */
const CLERK_HOSTS = [/\.clerk\.accounts\.dev$/, /^clerk\./];

/**
 * Social sign-ins. Google refuses to sign in inside an app's window, and the
 * rest are better in the browser where the person is already signed in, so
 * these go to the browser and come back through a `nibblets:` link.
 */
const PROVIDER_HOSTS = [
  /^accounts\.google\.com$/,
  /^github\.com$/,
  /^appleid\.apple\.com$/,
  /^login\.microsoftonline\.com$/,
];

const matches = (target: string, hosts: RegExp[]): boolean => {
  try {
    const to = new URL(target);
    return to.protocol === "https:" && hosts.some((host) => host.test(to.hostname));
  } catch {
    return false;
  }
};

/** Whether the main window may go to `target`: the UI's own origin, or a step of Clerk's sign-in. */
export function navigationAllowed(target: string, ui: string): boolean {
  try {
    if (new URL(target).origin === new URL(ui).origin) return true;
  } catch {
    return false;
  }
  return matches(target, CLERK_HOSTS);
}

/** Whether `target` is a social sign-in, to be done in the browser instead. */
export function isProviderSignIn(target: string): boolean {
  return matches(target, PROVIDER_HOSTS);
}

/** The app's own link scheme: `nibblets://sign-in?state=…&handle=…`. */
export const APP_SCHEME = "nibblets";

/** A sign-in coming back from the browser, from a `nibblets:` link. */
export function parseSignInLink(link: string): { state: string; handle: string } | null {
  try {
    const url = new URL(link);
    if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== "sign-in") return null;
    const state = url.searchParams.get("state");
    const handle = url.searchParams.get("handle");
    return state && handle ? { state, handle } : null;
  } catch {
    return null;
  }
}
