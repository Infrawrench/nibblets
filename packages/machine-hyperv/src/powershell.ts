import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Runs PowerShell for Hyper-V's cmdlets, which are the only way in. A
 * script never has a value spliced into it: its parameters go in the
 * environment as JSON (`$p`), and it says what it has to say as JSON on its
 * last line, so nothing a nibblet's id or a path holds can become code.
 */
export type PowerShell = (script: string, params: object) => Promise<string>;

/** `-EncodedCommand` takes the script as base64 of UTF-16LE. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** What every script starts with: stop at the first error, and the parameters in `$p`. */
export const PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $env:NIBBLET_PS | ConvertFrom-Json
`;

export const powershell: PowerShell = (script, params) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodeCommand(PRELUDE + script),
      ],
      {
        env: { ...process.env, NIBBLET_PS: JSON.stringify(params) },
        timeout: 10 * 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const said = (stderr || stdout).trim().split(/\r?\n/).slice(-4).join(" ");
          reject(new Error(said || err.message));
        } else resolve(stdout);
      },
    );
  });

/** Runs a script and reads the JSON on its last line. */
export async function psJson<T>(
  ps: PowerShell,
  schema: z.ZodType<T>,
  script: string,
  params: object,
): Promise<T> {
  const out = (await ps(script, params)).trim().split(/\r?\n/).at(-1) ?? "null";
  return schema.parse(JSON.parse(out));
}
