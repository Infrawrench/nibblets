import { contract, flatten } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";
import type { Services } from "./handlers.ts";

// Serving the description touches none of the services.
const services = {
  config: { NIBBLET_OWNER_TOKEN: "owner", NIBBLET_WEB_DIST: "/nonexistent" },
  conductor: {},
  version: "1.2.3",
} as unknown as Services;

async function served() {
  const res = await createApp(services, new Bus()).request("/api/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    info: { version: string };
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };
}

describe("/api/openapi.json", () => {
  it("is served to anyone, for this server's version", async () => {
    expect((await served()).info.version).toBe("1.2.3");
  });

  it("describes every procedure and the plain HTTP routes", async () => {
    const { paths } = await served();
    for (const path of flatten(contract).keys()) expect(paths).toHaveProperty([`/api/rpc/${path}`]);
    for (const [path, method] of [
      ["/healthz", "get"],
      ["/api/pair", "post"],
      ["/api/ticket", "post"],
      ["/api/live", "get"],
      ["/api/nibblets/{id}/terminal", "get"],
      ["/api/nibblets/{id}/files", "post"],
      ["/api/files/{id}/link", "post"],
      ["/api/files/{id}", "get"],
      ["/bank/{kind}/purchases", "post"],
    ]) {
      expect(paths[path!]).toHaveProperty([method!]);
    }
  });

  it("only refers to schemas it defines", async () => {
    const doc = await served();
    for (const [, name] of JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)) {
      expect(doc.components.schemas).toHaveProperty([name!]);
    }
  });
});
