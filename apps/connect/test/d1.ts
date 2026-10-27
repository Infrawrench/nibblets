import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types/index.ts";

/** A real D1 database (Miniflare) with every migration applied, in order, as wrangler applies them. */
export async function migratedDb(
  name: string,
): Promise<{ db: D1Database; dispose(): Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null) } }",
    d1Databases: { DB: name },
  });
  const db = await mf.getD1Database("DB");
  const dir = fileURLToPath(new URL("../migrations", import.meta.url));
  const schema = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join(";\n");
  const statements = schema
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
  return { db, dispose: () => mf.dispose() };
}

/** An ES256 private key as Connect keeps it in JWT_PRIVATE_KEY. */
export async function privateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return JSON.stringify({
    ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    kid: "test-key",
  });
}
