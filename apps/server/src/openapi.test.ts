import { contract, flatten } from "@nibblet/protocol";
import { openApiDocument } from "@nibblet/protocol/openapi";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENAPI_FILE, openApiFile } from "./openapi.ts";

describe("openapi", () => {
  it("describes every procedure", () => {
    const { paths } = openApiDocument("0.0.0");
    for (const path of flatten(contract).keys()) expect(paths).toHaveProperty([`/api/rpc/${path}`]);
  });

  it("only refers to schemas it defines", () => {
    const doc = openApiDocument("0.0.0");
    const refs = JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g);
    for (const [, name] of refs) expect(doc.components.schemas).toHaveProperty([name!]);
  });

  it("is up to date in the repository (run `pnpm openapi`)", () => {
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(openApiFile());
  });
});
