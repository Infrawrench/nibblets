// Cuts a release: `pnpm release 0.2.0`. Sets every package's version,
// commits, and pushes to main. The Release workflow sees a version without a
// tag, builds and publishes the images and the signed Mac app, then tags
// v0.2.0 and makes the GitHub release. Servers and the app offer it from then on.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
if (sh("git", ["tag", "-l", `v${version}`])) {
  console.error(`v${version} is already released.`);
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

sh("git", ["add", ...files]);
sh("git", ["commit", "-m", `Release ${version}`]);
sh("git", ["push", "origin", "main"]);
console.log(`Pushed ${version}. The Release workflow builds and publishes it:`);
console.log(sh("gh", ["run", "list", "--workflow", "release.yml", "--limit", "1"]));
