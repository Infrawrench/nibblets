/**
 * Release notes (Markdown) as plain text for a native dialog, which can't
 * show Markdown: headings as plain lines, bullets as •, no emphasis, links
 * or code marks. The install instructions are left out, since the app
 * installs the update itself.
 */
export function formatNotes(markdown: string, maxItems = 10): string {
  const out: string[] = [];
  let items = 0;
  let hidden = 0;
  let afterHeading = false;
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading && /^install/i.test(heading[1] ?? "")) break;
    if (heading) {
      if (out.length && out.at(-1) !== "") out.push("");
      out.push(inline(heading[1] ?? ""));
      afterHeading = true;
      continue;
    }
    if (!line) {
      // A heading's own items follow it directly.
      if (!afterHeading && out.length && out.at(-1) !== "") out.push("");
      continue;
    }
    afterHeading = false;
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (items++ >= maxItems) hidden++;
      else out.push(`• ${inline(bullet[1] ?? "")}`);
      continue;
    }
    out.push(inline(line));
  }
  if (hidden) out.push(`• and ${hidden} more`);
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}

/** Emphasis, code and links, without their marks. */
function inline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}
