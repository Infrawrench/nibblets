// Bundles the main and preload scripts for Electron and copies the static
// files beside them. Electron loads out/main.cjs.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

await mkdir("out", { recursive: true });
await build({
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
  outdir: "out",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // Native: shipped beside the bundle (below) rather than bundled.
  external: ["electron", "electron/main", "node-pty"],
  sourcemap: true,
  logLevel: "info",
});
// The setup window's script, with the terminal it shows.
await build({
  entryPoints: { "setup-ui": "src/setup-ui.ts" },
  outdir: "out",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome140",
  logLevel: "info",
});
await cp("node_modules/@xterm/xterm/css/xterm.css", "out/xterm.css");
// node-pty's JavaScript and prebuilt binaries, where the bundle's require finds them.
// Installs drop the helper's execute bit, without which nothing can start.
const pty = "out/node_modules/node-pty";
await rm(pty, { recursive: true, force: true });
await mkdir(pty, { recursive: true });
// `prebuilds` covers macOS and Windows; on Linux it's compiled at install, into `build`.
for (const part of ["package.json", "lib", "prebuilds", "build/Release", "LICENSE"]) {
  const from = join("node_modules/node-pty", part);
  if (!existsSync(from)) continue;
  await cp(from, join(pty, part), { recursive: true, dereference: true });
}
for (const dir of existsSync(join(pty, "prebuilds")) ? await readdir(join(pty, "prebuilds")) : []) {
  const helper = join(pty, "prebuilds", dir, "spawn-helper");
  if (existsSync(helper)) await chmod(helper, 0o755);
}
await cp("src/setup.html", "out/setup.html");
await cp("assets/trayTemplate.png", "out/trayTemplate.png");
await cp("assets/trayTemplate@2x.png", "out/trayTemplate@2x.png");

// Apple's VM helper (packages/machine-apple/helper), on a Mac with the
// Swift compiler, signed for this Mac; a release signs it again with the
// app's identity and the virtualization entitlement.
if (process.platform === "darwin") {
  const helper = "../../packages/machine-apple/helper";
  try {
    execFileSync("swiftc", [
      "-O",
      "-swift-version",
      "5",
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13`,
      "-o",
      "out/nibblet-vm",
      join(helper, "main.swift"),
      "-framework",
      "Virtualization",
      "-framework",
      "AppKit",
    ]);
    execFileSync("codesign", [
      "-s",
      "-",
      "-f",
      "--entitlements",
      join(helper, "vm.entitlements"),
      "out/nibblet-vm",
    ]);
  } catch (err) {
    console.warn(`No VM helper (virtual machines will build their own): ${err.message}`);
  }
}
