import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GuardAppView, ToolRule } from "@nibblets/protocol";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpGate } from "../src/gate.ts";
import { callForView } from "../src/view-calls.ts";
import { FARES_VIEW } from "./fixtures/views-server.ts";

const fixture = fileURLToPath(new URL("./fixtures/views-server.ts", import.meta.url));

let rules: ToolRule[] = [];
const asked: string[] = [];
let reported: GuardAppView[] = [];
const logged: string[] = [];
const gate = new McpGate({
  ask: async (server, tool) => {
    asked.push(`${server}/${tool}`);
    return { approved: true, reason: null };
  },
  rules: () => rules,
  log: (message) => logged.push(message),
  view: async (report) => {
    reported.push(report);
  },
});

const base = () => gate.urlFor("fares").replace(/\/mcp\/fares$/, "");

beforeAll(async () => {
  await gate.start();
  gate.wrap("fares", {
    type: "stdio",
    command: process.execPath,
    args: [fixture, "stdio"],
    env: {},
  });
});

afterAll(() => gate.close());

beforeEach(() => {
  rules = [];
  asked.length = 0;
  reported = [];
  logged.length = 0;
});

async function connect(path: "mcp" | "app"): Promise<Client> {
  const client = new Client({ name: "harness", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/${path}/fares`)));
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.stringify("content" in result ? result.content : result);

describe("MCP App views behind the gate", () => {
  it("hides tools only a view may call from the agent", async () => {
    const client = await connect("mcp");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["plain_page", "search_fares"]);
    const result = await client.callTool({ name: "hold_fare", arguments: { flight: "U2" } });
    expect("isError" in result && result.isError).toBe(true);
    expect(text(result)).toContain("only for its view");
    await client.close();
  });

  it("reports the agent's call of a tool with a view, with the view", async () => {
    const client = await connect("mcp");
    const result = await client.callTool({ name: "search_fares", arguments: { to: "LIS" } });
    expect(text(result)).toContain("fares to LIS");
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(reported[0]).toMatchObject({
      server: "fares",
      tool: "search_fares",
      input: { to: "LIS" },
      result: { structuredContent: { fares: [{ to: "LIS", price: 96 }] } },
      uri: "ui://fares/view.html",
      view: {
        html: FARES_VIEW,
        csp: { connectDomains: ["https://api.fares.test"] },
        prefersBorder: false,
      },
    });
    await client.close();
  });

  it("doesn't report a view that isn't an MCP App, or a tool without one", async () => {
    const client = await connect("mcp");
    await client.callTool({ name: "plain_page", arguments: {} });
    await vi.waitFor(() => expect(logged.join()).toContain("isn't an MCP App"));
    expect(reported).toEqual([]);
    await client.close();
  });

  it("lets a view call its tools, gated, without reporting them again", async () => {
    rules = [{ server: "fares", tool: "hold_fare" }];
    const client = await connect("app");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["hold_fare", "plain_page", "search_fares"]);
    const result = await client.callTool({ name: "hold_fare", arguments: { flight: "U2" } });
    expect(text(result)).toContain("held U2");
    expect(asked).toEqual(["fares/hold_fare"]);
    await client.close();
    // A report would be on its way by now.
    await new Promise((r) => setTimeout(r, 100));
    expect(reported).toEqual([]);
  });

  it("makes a view's call for the runner, and says why one failed", async () => {
    const appUrl = (server: string) => `${base()}/app/${server}`;
    const done = await callForView(
      {
        type: "view_call",
        requestId: "r1",
        server: "fares",
        tool: "hold_fare",
        arguments: { flight: "TP1" },
      },
      appUrl,
    );
    expect(done).toMatchObject({ requestId: "r1", error: null });
    expect(JSON.stringify(done.result)).toContain("held TP1");

    const missing = await callForView(
      { type: "view_call", requestId: "r2", server: "nope", tool: "x", arguments: {} },
      appUrl,
    );
    expect(missing).toMatchObject({ requestId: "r2", result: null });
    expect(missing.error).toBeTruthy();
  });
});
