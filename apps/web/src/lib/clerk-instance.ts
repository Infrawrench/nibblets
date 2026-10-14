import { storage } from "./storage.ts";

/*
 * Clerk keeps its sign-in in cookies and storage on this origin. Left over
 * from a different Clerk instance (Connect moved from a development instance
 * to production), they leave Clerk never finishing loading, so a blank page.
 * When the instance changes, they're cleared first: it signs the person out,
 * once.
 */

const KEY = "nibblets.clerkInstance";

/** Clerk's own cookies, by name: its client and session markers and the dev browser token. */
export function clerkCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter((name) => /^__(client_uat|session|clerk|refresh)/.test(name));
}

/** Whether this origin's Clerk state may belong to another instance than `publishableKey`'s. */
export function needsClearing(previous: string | null, publishableKey: string): boolean {
  return previous !== publishableKey;
}

export function forgetOtherClerkInstance(publishableKey: string): void {
  if (!needsClearing(storage.get(KEY), publishableKey)) return;
  for (const name of clerkCookieNames(document.cookie)) {
    // Clerk sets them on this host and on the parent domain.
    const parent = window.location.hostname.split(".").slice(-2).join(".");
    for (const domain of ["", `; domain=${parent}`]) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("__clerk")) localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable: nothing of Clerk's in it either.
  }
  storage.set(KEY, publishableKey);
}
