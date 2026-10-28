import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolRule } from "@nibblets/protocol";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpGate, type Decision } from "../src/gate.ts";
import { toolsServer } from "./fixtures/tools-server.ts";

const fixture = fileURLToPath(new URL("./fixtures/tools-server.ts", import.meta.url));

let rules: ToolRule[] = [];
let answer: Decision = { approved: true, reason: null };
const asked: string[] = [];
const gate = new McpGate({
  ask: async (server, tool) => {
    asked.push(`${server}/${tool}`);
    return answer;
  },
  rules: () => rules,
  log: () => {},
});

// The same fixture over streamable HTTP, as a nibblet's remote server would be.
let http: Server;
let httpUrl = "";

beforeAll(async () => {
  await gate.start();
  http = createServer((req, res) => {
    void (async () => {
      const server = toolsServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => void server.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })();
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const address = http.address();
  httpUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
});

afterAll(async () => {
  await gate.close();
  await new Promise<void>((r) => http.close(() => r()));
});

async function connect(name: string, url: string): Promise<Client> {
  const client = new Client({ name: "harness", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.stringify("content" in result ? result.content : result);

for (const kind of ["stdio", "http"] as const) {
  describe(`gate over ${kind}`, () => {
    const name = `tools-${kind}`;
    const spec = () =>
      kind === "stdio"
        ? { type: "stdio" as const, command: process.execPath, args: [fixture, "stdio"], env: {} }
        : { type: "http" as const, url: httpUrl, headers: {} };

    it("lists tools unchanged and forwards ungated calls", async () => {
      rules = [{ server: name, tool: "send_*" }];
      asked.length = 0;
      const wrapped = gate.wrap(name, spec());
      const client = await connect(name, wrapped.type === "http" ? wrapped.url : "");
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "send_money"]);
      expect(text(await client.callTool({ name: "echo", arguments: { text: "hi" } }))).toContain(
        "echo: hi",
      );
      expect(asked).toEqual([]);
      await client.close();
    });

    it("forwards a gated call once approved", async () => {
      rules = [{ server: name, tool: "send_*" }];
      answer = { approved: true, reason: null };
      asked.length = 0;
      const wrapped = gate.wrap(name, spec());
      const client = await connect(name, wrapped.type === "http" ? wrapped.url : "");
      const result = await client.callTool({ name: "send_money", arguments: { amount: 5 } });
      expect(asked).toEqual([`${name}/send_money`]);
      expect(text(result)).toContain("sent 5");
      await client.close();
    });

    it("answers for a declined call with an error the agent can read", async () => {
      rules = [{ server: name, tool: "*" }];
      answer = { approved: false, reason: "not today" };
      const wrapped = gate.wrap(name, spec());
      const client = await connect(name, wrapped.type === "http" ? wrapped.url : "");
      const result = await client.callTool({ name: "send_money", arguments: { amount: 5 } });
      expect("isError" in result && result.isError).toBe(true);
      expect(text(result)).toContain("declined");
      expect(text(result)).toContain("not today");
      expect(text(result)).not.toContain("sent 5");
      await client.close();
    });
  });
}

describe("a server the gate limits to some of its tools", () => {
  it("lists and allows only those, refusing the rest before asking", async () => {
    rules = [{ server: "limited", tool: "send_*" }];
    asked.length = 0;
    const wrapped = gate.wrap(
      "limited",
      { type: "http", url: httpUrl, headers: {} },
      { tools: ["echo"] },
    );
    const client = await connect("limited", wrapped.type === "http" ? wrapped.url : "");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(text(await client.callTool({ name: "echo", arguments: { text: "hi" } }))).toContain(
      "echo: hi",
    );
    const refused = await client.callTool({ name: "send_money", arguments: { amount: 5 } });
    expect("isError" in refused && refused.isError).toBe(true);
    expect(text(refused)).toContain("isn't one of limited's tools you were given");
    expect(text(refused)).not.toContain("sent 5");
    expect(asked).toEqual([]);
    await client.close();
  });

  it("lets everything through again once the limit is lifted", async () => {
    rules = [];
    const wrapped = gate.wrap("limited", { type: "http", url: httpUrl, headers: {} });
    const client = await connect("limited", wrapped.type === "http" ? wrapped.url : "");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "send_money",
    ]);
    expect(text(await client.callTool({ name: "send_money", arguments: { amount: 5 } }))).toContain(
      "sent 5",
    );
    await client.close();
  });
});

describe("a server the gate limits to some of an app's providers", () => {
  // The fixture's `echo` stands in for a tool whose `text` names where it acts.
  const limit = { argument: "text", allowed: ["laptop", "vps"], home: "laptop", actHome: [] };

  it("allows a call on one it was given, or on its home when it names none", async () => {
    rules = [];
    const wrapped = gate.wrap(
      "machines",
      { type: "http", url: httpUrl, headers: {} },
      { providers: limit },
    );
    const client = await connect("machines", wrapped.type === "http" ? wrapped.url : "");
    expect(text(await client.callTool({ name: "echo", arguments: { text: "vps" } }))).toContain(
      "echo: vps",
    );
    expect(text(await client.callTool({ name: "send_money", arguments: { amount: 5 } }))).toContain(
      "sent 5",
    );
    const refused = await client.callTool({ name: "echo", arguments: { text: "desktop" } });
    expect("isError" in refused && refused.isError).toBe(true);
    expect(text(refused)).toContain("would act on desktop in machines, which you weren't given");
    await client.close();
  });

  it("refuses a call on its home when that wasn't given, and one naming it as anything but text", async () => {
    asked.length = 0;
    rules = [{ server: "machines", tool: "*" }];
    const wrapped = gate.wrap(
      "machines",
      { type: "http", url: httpUrl, headers: {} },
      { providers: { ...limit, allowed: ["vps"] } },
    );
    const client = await connect("machines", wrapped.type === "http" ? wrapped.url : "");
    const home = await client.callTool({ name: "send_money", arguments: { amount: 5 } });
    expect(text(home)).toContain("would act on laptop");
    const odd = await client.callTool({ name: "echo", arguments: { text: 7 } });
    expect("isError" in odd && odd.isError).toBe(true);
    expect(text(odd)).not.toContain("echo:");
    // Refused before anyone was asked.
    expect(asked).toEqual([]);
    await client.close();
  });

  it("takes a tool that always acts on its home at its word", async () => {
    rules = [];
    const wrapped = gate.wrap(
      "machines",
      { type: "http", url: httpUrl, headers: {} },
      { providers: { ...limit, actHome: ["echo"] } },
    );
    const client = await connect("machines", wrapped.type === "http" ? wrapped.url : "");
    expect(text(await client.callTool({ name: "echo", arguments: { text: "desktop" } }))).toContain(
      "echo: desktop",
    );
    await client.close();
  });
});
