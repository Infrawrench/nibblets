import { openApiDocument } from "@nibblet/protocol/openapi";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the document is kept in the repository, for people and tools to use without a server. */
export const OPENAPI_FILE = new URL("../openapi.json", import.meta.url);

/** The document as it's kept: for the repository's version, formatted for diffs. */
export function openApiFile(): string {
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")));
  return `${JSON.stringify(openApiDocument(version), null, 2)}\n`;
}

// `pnpm openapi` writes it after the contract changes.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OPENAPI_FILE, openApiFile());
  console.log(`Wrote ${fileURLToPath(OPENAPI_FILE)}`);
}
