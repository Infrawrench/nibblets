import type { AppViewCsp, AppViewPermissions } from "@nibblets/protocol";

/**
 * A source a view may name in its CSP: a web or socket address, perhaps
 * with a wildcard subdomain, a port and a path. Anything else (a keyword, or
 * text that would end the directive) is left out.
 */
const SOURCE =
  /^(https?|wss?):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:(\d{1,5}|\*))?(\/[\w\-./~%]*)?$/i;

/** The sources out of a list that are safe to put in a policy. */
export function safeSources(domains: readonly string[] | undefined): string[] {
  return (domains ?? []).filter((d) => SOURCE.test(d));
}

/** What a view's CSP asks for, keeping only sources that are safe to put in a policy. */
export function cleanCsp(csp: AppViewCsp): AppViewCsp {
  return {
    connectDomains: safeSources(csp.connectDomains),
    resourceDomains: safeSources(csp.resourceDomains),
    frameDomains: safeSources(csp.frameDomains),
    baseUriDomains: safeSources(csp.baseUriDomains),
  };
}

/**
 * The Content Security Policy a view runs under: its own HTML, inline
 * scripts and styles, and only the other places its resource names. Never
 * `'self'`: the frame's origin is opaque, and the server isn't for it.
 */
export function viewPolicy(csp: AppViewCsp): string {
  const { connectDomains, resourceDomains, frameDomains, baseUriDomains } = cleanCsp(csp);
  const list = (base: string[], more: string[] | undefined) =>
    [...base, ...(more ?? [])].join(" ") || "'none'";
  return [
    "default-src 'none'",
    `script-src ${list(["'unsafe-inline'"], resourceDomains)}`,
    `style-src ${list(["'unsafe-inline'"], resourceDomains)}`,
    `img-src ${list(["data:", "blob:"], resourceDomains)}`,
    `font-src ${list(["data:"], resourceDomains)}`,
    `media-src ${list(["data:", "blob:"], resourceDomains)}`,
    `connect-src ${list([], connectDomains)}`,
    `frame-src ${list([], frameDomains)}`,
    `base-uri ${list([], baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * A view's HTML with its policy first in it, so it applies before anything
 * of the view's own runs. After a doctype, which has to come first.
 */
export function withPolicy(html: string, csp: AppViewCsp): string {
  const policy = viewPolicy(csp).replace(/"/g, "&quot;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : meta + html;
}

/**
 * What a view is allowed of what it asks for. Only writing to the
 * clipboard: the frame would inherit this page's camera, microphone and
 * location, which the person gave the Nibblets app (for sharing where they
 * are, say), not the view.
 */
export function grantedPermissions(asked: AppViewPermissions): AppViewPermissions {
  return asked.clipboardWrite ? { clipboardWrite: {} } : {};
}

/** The tallest a view grows in the thread before it scrolls inside itself. */
export const MAX_VIEW_HEIGHT = 720;

/** How tall to draw a view that says it's `height` high. */
export function viewHeight(height: number | undefined, fallback: number): number {
  if (height === undefined || !Number.isFinite(height)) return fallback;
  return Math.min(Math.max(Math.ceil(height), 24), MAX_VIEW_HEIGHT);
}
