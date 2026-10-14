/** Web and mail addresses: the only kinds of link the UI opens or follows. */
export function isSafeLink(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url, "https://x.invalid").protocol);
  } catch {
    return false;
  }
}

/** Opens a web address in a new tab; anything else (javascript:, file:) is ignored. */
export function openWeb(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") window.open(url, "_blank", "noopener");
  } catch {
    // Not a URL; nothing to open.
  }
}
