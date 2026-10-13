// Bundles the main and preload scripts for Electron and copies the static
// files beside them. Electron loads out/main.cjs.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await mkdir("out", { recursive: true });
await build({
  entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
  outdir: "out",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "electron/main"],
  sourcemap: true,
  logLevel: "info",
});
await cp("src/setup.html", "out/setup.html");
await cp("assets/trayTemplate.png", "out/trayTemplate.png");
await cp("assets/trayTemplate@2x.png", "out/trayTemplate@2x.png");
