// Bundles the main and preload scripts for Electron and copies the static
// files beside them. Electron loads out/main.cjs.
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
for (const part of ["package.json", "lib", "prebuilds", "LICENSE"]) {
  await cp(join("node_modules/node-pty", part), join(pty, part), {
    recursive: true,
    dereference: true,
  });
}
for (const dir of await readdir(join(pty, "prebuilds"))) {
  const helper = join(pty, "prebuilds", dir, "spawn-helper");
  if (existsSync(helper)) await chmod(helper, 0o755);
}
await cp("src/setup.html", "out/setup.html");
await cp("assets/trayTemplate.png", "out/trayTemplate.png");
await cp("assets/trayTemplate@2x.png", "out/trayTemplate@2x.png");
