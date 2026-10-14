// Cuts a release: `pnpm release 0.2.0`. Sets every package's version, commits,
// tags v0.2.0, pushes, and publishes a GitHub release with generated notes.
// Servers and the desktop app offer it as an update from then on.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: pnpm release <major.minor.patch>");
  process.exit(2);
}
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
if (sh("git", ["status", "--porcelain"])) {
  console.error("Commit or stash your changes first.");
  process.exit(1);
}
if (sh("git", ["branch", "--show-current"]) !== "main") {
  console.error("Releases are cut from main.");
  process.exit(1);
}

const files = ["package.json"];
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(group)) {
    const file = join(group, name, "package.json");
    if (existsSync(file)) files.push(file);
  }
}
for (const file of files) {
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}

const tag = `v${version}`;
sh("git", ["add", ...files]);
sh("git", ["commit", "-m", `Release ${version}`]);
sh("git", ["tag", tag]);
sh("git", ["push", "origin", "main", tag]);
console.log(
  sh("gh", ["release", "create", tag, "--title", `Nibblets ${version}`, "--generate-notes"]),
);
