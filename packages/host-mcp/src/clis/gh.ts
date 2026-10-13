import type { CliPlugin, RunResult } from "./cli.ts";

/** The account and host from `gh auth status`, which prints to stderr on older versions. */
export function parseGhStatus(result: RunResult): { host: string; account: string } | null {
  const text = `${result.stdout}\n${result.stderr}`;
  const match = /Logged in to (\S+) (?:account|as) (\S+)/.exec(text);
  return match?.[1] && match[2] ? { host: match[1], account: match[2] } : null;
}

/**
 * The GitHub CLI. Its token comes from `gh auth token`, so it works whether
 * gh keeps it in the system keychain or in hosts.yml.
 */
export const ghPlugin: CliPlugin = {
  id: "gh",
  label: "GitHub CLI",
  async detect(run) {
    const base = { id: "gh", label: "GitHub CLI" };
    const version = await run("gh", ["--version"]);
    if (version.code !== 0) {
      return { ...base, installed: false, signedIn: false, account: null, detail: null };
    }
    const status = parseGhStatus(await run("gh", ["auth", "status", "--active"]));
    return status
      ? { ...base, installed: true, signedIn: true, account: status.account, detail: status.host }
      : {
          ...base,
          installed: true,
          signedIn: false,
          account: null,
          detail: "Run `gh auth login` on the host",
        };
  },
  async credential(run) {
    const status = parseGhStatus(await run("gh", ["auth", "status", "--active"]));
    const host = status?.host ?? "github.com";
    const token = await run("gh", ["auth", "token", "--hostname", host]);
    const value = token.stdout.trim();
    if (token.code !== 0 || !value) throw new Error("gh isn't signed in on the host");
    const env: Record<string, string> =
      host === "github.com"
        ? { GH_TOKEN: value, GITHUB_TOKEN: value }
        : { GH_ENTERPRISE_TOKEN: value, GH_HOST: host };
    return { env, setup: [["gh", "auth", "setup-git"]] };
  },
};
