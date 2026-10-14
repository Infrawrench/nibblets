// electron-builder's afterSign hook: notarises the Mac app, then staples the
// ticket to it. Notarising has to succeed. Stapling only saves Gatekeeper a
// lookup: Apple's ticket service (CloudKit) often drops the connection from
// CI runners ("Error 68"), so it's retried and, failing that, skipped, since
// an unstapled notarised app is still let through once it's looked up online.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      "  • not notarising: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD or APPLE_TEAM_ID isn't set",
    );
    return;
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const zip = `${app}.zip`;
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
  console.log("  • notarising", app);
  execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      zip,
      "--apple-id",
      APPLE_ID,
      "--password",
      APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      APPLE_TEAM_ID,
      "--wait",
    ],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", zip]);
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
      return;
    } catch {
      console.log(`  • stapling attempt ${attempt} failed`);
      await sleep(20_000);
    }
  }
  console.log("::warning::Notarised but not stapled; Gatekeeper will look the ticket up online");
};
