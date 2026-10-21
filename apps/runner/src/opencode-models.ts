/**
 * `node apps/runner/src/opencode-models.ts`: lists the models OpenCode offers
 * with the host's login, set up exactly as an OpenCode nibblet would have it.
 * The server runs it in a throwaway runner container, with the login (an
 * `OpencodeLogin` as JSON) on stdin, and reads `{ models }` from stdout.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeLogin } from "@nibblets/protocol";
import { installLogin, parseModelsVerbose, prepareHome } from "@nibblets/harness-opencode";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const login = OpencodeLogin.parse(JSON.parse(await readStdin()));
  const home = await mkdtemp(path.join(tmpdir(), "opencode-models-"));
  try {
    await installLogin(await prepareHome(home), login, path.join(home, "secrets"));
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        "opencode",
        // --refresh waits for models.dev; without it a fresh container lists the
        // CLI's built-in snapshot, which misses much of what providers offer.
        ["models", "--verbose", "--refresh"],
        { env: process.env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
        (err, out, errOut) =>
          err ? reject(new Error(String(errOut).trim() || err.message)) : resolve(String(out)),
      ),
    );
    process.stdout.write(JSON.stringify({ models: parseModelsVerbose(stdout) }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
