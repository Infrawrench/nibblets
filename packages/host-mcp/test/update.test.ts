import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHostMcpBridge, type HostMcpBridge } from "../src/bridge.ts";
import type { AppUpdaterHost } from "../src/update.ts";

const TOKEN = "test-token-0123456789";
const applied: string[] = [];
const updater: AppUpdaterHost = {
  describe: async () => ({ method: "here", updating: applied.length > 0, error: null }),
  apply: async (version) => void applied.push(version),
};

let bridge: HostMcpBridge;
let plain: HostMcpBridge;

beforeAll(async () => {
  bridge = await startHostMcpBridge({ port: 0, token: TOKEN, configPaths: [], updater });
  plain = await startHostMcpBridge({ port: 0, token: TOKEN, configPaths: [] });
});

afterAll(async () => {
  await bridge.close();
  await plain.close();
});

const call = (b: HostMcpBridge, method: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${b.port}/update`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("the bridge's update routes", () => {
  it("says how this host updates, and starts an update", async () => {
    expect(await (await call(bridge, "GET")).json()).toMatchObject({
      method: "here",
      updating: false,
    });
    const res = await call(bridge, "POST", { version: "0.2.0" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ updating: true });
    expect(applied).toEqual(["0.2.0"]);
  });

  it("can't update without an updater", async () => {
    expect(await (await call(plain, "GET")).json()).toMatchObject({ method: "manual" });
    expect((await call(plain, "POST", { version: "0.2.0" })).status).toBe(409);
  });
});
