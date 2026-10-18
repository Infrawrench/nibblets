import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cliHarnesses, HARNESS_CLI_DIR, HarnessId, harnesses } from "@nibblet/protocol";

const run = promisify(execFile);

/**
 * Installs harness CLIs into the shared volume runners read them from. The
 * server runs this in a throwaway runner container, as root, with the
 * volume mounted read-write:
 *
 *   node harness-cli.ts versions            each harness's bundled and installed CLI, as JSON
 *   node harness-cli.ts install <id> <ver>  installs that release, checks it runs, makes it current
 *   node harness-cli.ts bundled <id>        goes back to the CLI in the image
 *
 * Each release gets its own folder; `current` is a symlink swapped in one
 * rename, so a runner never sees half an install. The previous release is
 * kept, so going back is quick.
 */

/** The release `current` points at, if it finished installing. */
export async function currentVersion(root: string, id: HarnessId): Promise<string | null> {
  try {
    const version = await readlink(path.join(root, id, "current"));
    return existsSync(path.join(root, id, version, ".ok")) ? version : null;
  } catch {
    return null;
  }
}

/** Points `current` at a release, atomically. */
export async function makeCurrent(root: string, id: HarnessId, version: string): Promise<void> {
  const tmp = path.join(root, id, `current.${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(version, tmp);
  await rename(tmp, path.join(root, id, "current"));
}

/** Removes every release but the ones named. */
export async function prune(root: string, id: HarnessId, keep: readonly string[]): Promise<void> {
  const dir = path.join(root, id);
  for (const entry of await readdir(dir).catch(() => [])) {
    if (entry === "current" || entry.startsWith("current.") || keep.includes(entry)) continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function install(root: string, id: HarnessId, version: string): Promise<string> {
  if (!/^[\w.+-]+$/.test(version)) throw new Error(`Not a version: ${version}`);
  const { package: pkg, bin } = harnesses[id].cli;
  const dir = path.join(root, id, version);
  const ok = path.join(dir, ".ok");
  if (!existsSync(ok)) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await run(
      "npm",
      [
        "install",
        "--prefix",
        dir,
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--omit=dev",
        `${pkg}@${version}`,
      ],
      { env: { ...process.env, npm_config_cache: "/tmp/npm-cache" }, timeout: 10 * 60_000 },
    );
    // It has to run before any nibblet is pointed at it.
    const { stdout } = await run(path.join(dir, "node_modules", ".bin", bin), ["--version"], {
      timeout: 60_000,
    });
    await writeFile(ok, stdout);
  }
  const previous = await currentVersion(root, id);
  await makeCurrent(root, id, version);
  await prune(root, id, [version, ...(previous ? [previous] : [])]);
  return version;
}

async function main(): Promise<void> {
  const root = process.env.NIBBLET_HARNESS_DIR ?? HARNESS_CLI_DIR;
  const [command, rawId, version] = process.argv.slice(2);
  if (command === "versions") {
    // Imported here: loading every harness is only needed for this command.
    const { plugins } = await import("./plugins.ts");
    const out: Record<string, { bundled: string; installed: string | null }> = {};
    for (const id of cliHarnesses) {
      out[id] = { bundled: plugins[id].bundledCli(), installed: await currentVersion(root, id) };
    }
    console.log(JSON.stringify(out));
    return;
  }
  const id = HarnessId.parse(rawId);
  if (!cliHarnesses.includes(id))
    throw new Error(`${id} runs ${harnesses[id].cli.name}, kept under its own harness`);
  if (command === "install" && version) {
    console.log(JSON.stringify({ installed: await install(root, id, version) }));
  } else if (command === "bundled") {
    await rm(path.join(root, id, "current"), { force: true });
    console.log(JSON.stringify({ installed: null }));
  } else {
    throw new Error("usage: harness-cli.ts versions | install <id> <version> | bundled <id>");
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
