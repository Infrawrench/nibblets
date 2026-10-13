import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const claudeFile = join(homedir(), ".claude/.credentials.json");
export const codexFile = join(homedir(), ".codex/auth.json");

export interface DetectedCredentials {
  claude: "keychain" | "file" | "none";
  codex: "file" | "none";
}

export async function detectCredentials(): Promise<DetectedCredentials> {
  let claude: DetectedCredentials["claude"] = "none";
  if (process.platform === "darwin" && (await readClaudeKeychain()) !== null) claude = "keychain";
  else if (existsSync(claudeFile)) claude = "file";
  return { claude, codex: existsSync(codexFile) ? "file" : "none" };
}

/** The keychain item's JSON, or null when Claude Code isn't signed in here. */
export async function readClaudeKeychain(): Promise<string | null> {
  try {
    const { stdout } = await run(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      {
        timeout: 10000,
      },
    );
    const text = stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

/** The item's account, which Claude Code looks the item up by. */
async function claudeKeychainAccount(): Promise<string> {
  try {
    const { stdout } = await run(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE],
      {
        timeout: 10000,
      },
    );
    const acct = /"acct"<blob>="([^"]*)"/.exec(stdout)?.[1];
    if (acct) return acct;
  } catch {
    // No item yet; Claude Code uses the login name.
  }
  return process.env.USER ?? "nibblet";
}

/**
 * Replaces the keychain item, keeping its account. The secret goes to
 * `security -i` on stdin, hex-encoded, so it never appears in a process
 * listing the way an argument would.
 */
export async function writeClaudeKeychain(text: string): Promise<void> {
  const account = await claudeKeychainAccount();
  const hex = Buffer.from(text, "utf8").toString("hex");
  const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  const command = `add-generic-password -U -a ${quote(account)} -s ${quote(CLAUDE_KEYCHAIN_SERVICE)} -X ${hex}\n`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && !stderr.trim()
        ? resolve()
        : reject(new Error(stderr || `security exited ${code}`)),
    );
    child.stdin.end(command);
  });
}
