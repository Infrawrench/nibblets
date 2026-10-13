import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHostMcpBridge, type HostMcpBridge } from "../src/bridge.ts";

const TOKEN = "test-token-0123456789";
const fixture = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));

let dir: string;
let bridge: HostMcpBridge;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "host-mcp-"));
  const config = join(dir, "host-mcp.json");
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] } } }),
  );
  bridge = await startHostMcpBridge({
    port: 0,
    token: TOKEN,
    configPaths: [{ label: "Test", path: config }],
  });
});

afterAll(async () => {
  await bridge.close();
  await rm(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${bridge.port}`;

describe("host MCP bridge", () => {
  it("refuses requests without the token", async () => {
    expect((await fetch(`${base()}/servers`)).status).toBe(401);
  });

  it("lists servers without starting them", async () => {
    const res = await fetch(`${base()}/servers`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await res.json()).toMatchObject([{ name: "echo", status: "idle", tools: [] }]);
  });

  it("proxies a tool call to the host server", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base()}/mcp/echo`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const result = await client.callTool({ name: "echo", arguments: { text: "hamster" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: retsmah" }]);
    await client.close();
  });

  it("lists a server's tools once something has used it", async () => {
    const res = await fetch(`${base()}/servers`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await res.json()).toMatchObject([
      { name: "echo", status: "ready", tools: [{ name: "echo" }] },
    ]);
  });

  it("404s unknown servers", async () => {
    const res = await fetch(`${base()}/mcp/nope`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
