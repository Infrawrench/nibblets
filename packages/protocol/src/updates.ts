import { z } from "zod";
import { HarnessId } from "./models.ts";

/** Where a harness's CLI stands: what's built in, what's been installed since, and what's out. */
export const HarnessUpdate = z.object({
  id: HarnessId,
  label: z.string(),
  /** The version in the runner image. Null until the server has looked. */
  bundled: z.string().nullable(),
  /** A newer version the server installed for runners, which wins over the bundled one. */
  installed: z.string().nullable(),
  /** The newest release on npm. Null until checked, or when the check failed. */
  latest: z.string().nullable(),
  updating: z.boolean(),
  error: z.string().nullable(),
});
export type HarnessUpdate = z.infer<typeof HarnessUpdate>;

export const HarnessUpdates = z.object({
  /** Install new releases by themselves. */
  auto: z.boolean(),
  checkedAt: z.string().nullable(),
  harnesses: z.array(HarnessUpdate),
});
export type HarnessUpdates = z.infer<typeof HarnessUpdates>;

export const AppRelease = z.object({
  version: z.string(),
  name: z.string(),
  /** The release notes, in Markdown. */
  notes: z.string(),
  url: z.url(),
  publishedAt: z.string().nullable(),
});
export type AppRelease = z.infer<typeof AppRelease>;

/** Whether a newer Nibblets is out, and whether this server can install it itself. */
export const AppUpdate = z.object({
  current: z.string(),
  latest: AppRelease.nullable(),
  available: z.boolean(),
  /**
   * How it updates: "here" when the host bridge can install it, "download"
   * for the desktop app (a new download), "manual" otherwise.
   */
  method: z.enum(["here", "download", "manual"]),
  /** Set while an update this server started is running. */
  updating: z.boolean(),
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type AppUpdate = z.infer<typeof AppUpdate>;

/** Compares dotted versions numerically ("2.1.10" > "2.1.9"); anything after a `-` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      ?.split(".")
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The Docker volume holding the harness CLIs the server installed, and where runners see it. */
export const HARNESS_CLI_VOLUME = "nibblet-harnesses";
export const HARNESS_CLI_DIR = "/opt/harnesses";

const GithubRelease = z.object({
  tag_name: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  html_url: z.url(),
  published_at: z.string().nullable(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
});

/**
 * The latest published release of a GitHub repository (`owner/name`), or
 * null when there isn't one, or the repository isn't public.
 */
export async function latestRelease(
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<AppRelease | null> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "nibblets" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const r = GithubRelease.parse(await res.json());
  if (r.draft || r.prerelease) return null;
  return {
    version: r.tag_name.replace(/^v/, ""),
    name: r.name || r.tag_name,
    notes: r.body ?? "",
    url: r.html_url,
    publishedAt: r.published_at,
  };
}
