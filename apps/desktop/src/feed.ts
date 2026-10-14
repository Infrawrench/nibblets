/**
 * Merges the update feeds (latest-mac.yml) that each Mac build writes, one
 * per architecture, into the one feed a release carries. electron-updater
 * picks the zip for its own architecture from the merged list.
 *
 *   node apps/desktop/src/feed.ts latest-mac-arm64.yml latest-mac-x64.yml > latest-mac.yml
 */
import { readFileSync } from "node:fs";

/** The `files:` entries of one feed, as their lines. */
function entries(feed: string): string[][] {
  const lines = feed.replace(/\r/g, "").split("\n");
  const start = lines.indexOf("files:");
  if (start < 0) throw new Error("Not an update feed: it has no files");
  const out: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    if (line.startsWith("  - ")) out.push([line]);
    else out.at(-1)?.push(line);
  }
  return out;
}

const urlOf = (entry: string[]) => /url:\s*(\S+)/.exec(entry[0] ?? "")?.[1] ?? "";

export function mergeFeeds(feeds: readonly string[]): string {
  const [first, ...rest] = feeds;
  if (first === undefined) throw new Error("No feeds to merge");
  const version = (feed: string) => /^version:\s*(\S+)/m.exec(feed)?.[1];
  for (const feed of rest) {
    if (version(feed) !== version(first)) {
      throw new Error(`The feeds are for different versions: ${version(first)}, ${version(feed)}`);
    }
  }
  const seen = new Set<string>();
  const files = feeds
    .flatMap(entries)
    .filter((e) => !seen.has(urlOf(e)) && seen.add(urlOf(e)))
    .flat();
  // The rest of the first feed (version, path, sha512, releaseDate) is kept as it is.
  const lines = first.replace(/\r/g, "").trimEnd().split("\n");
  const start = lines.indexOf("files:");
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith("  ")) end++;
  return [...lines.slice(0, start + 1), ...files, ...lines.slice(end)].join("\n") + "\n";
}

if (import.meta.main) {
  process.stdout.write(mergeFeeds(process.argv.slice(2).map((f) => readFileSync(f, "utf8"))));
}
