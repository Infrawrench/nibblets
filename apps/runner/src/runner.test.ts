import { defineHarness, type HarnessPlugin } from "@nibblet/harness";
import type { RunnerConfig, RunnerToServer, ServerToRunner } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { CliLogins } from "./cli.ts";
import { mcpServersFor, Runner } from "./runner.ts";

const config: RunnerConfig = {
  nibbletId: "n1",
  name: "Pip",
  harness: "claude",
  model: "claude-opus-5-5",
  effort: "medium",
  resumeSessionId: null,
  hostMcp: [],
  gated: [],
  cli: [],
  opencodeLogin: null,
};

/** A harness that echoes its input, or waits for an abort when told to. */
function fakeHarness(opened: string[]): HarnessPlugin {
  return defineHarness({
    id: "claude",
    version: () => "fake",
    bundledCli: () => "0.0.0",
    async open(ctx) {
      opened.push(`${ctx.config.model}:${ctx.config.resumeSessionId ?? "-"}`);
      let n = 0;
      return {
        async run(turn, out) {
          if (turn.input === "wait") {
            await new Promise((resolve) => turn.signal.addEventListener("abort", resolve));
            out.finish();
            return { status: "interrupted", error: null, usage: null, sessionId: "s" };
          }
          out.set(`${turn.turnId}-a`, "assistant_message", `echo ${turn.input}`);
          out.done(`${turn.turnId}-a`);
          out.finish();
          return { status: "completed", error: null, usage: null, sessionId: `s${++n}` };
        },
        async close() {},
      };
    },
  });
}

function setup() {
  const sent: RunnerToServer[] = [];
  const opened: string[] = [];
  const plugin = fakeHarness(opened);
  const runner = new Runner({
    plugins: { claude: plugin, codex: plugin, opencode: plugin },
    send: (msg) => sent.push(msg),
    workdir: "/tmp",
    mcpServers: {},
    hostMcp: (name) => ({ type: "http", url: `http://server/hostmcp/${name}`, headers: {} }),
    gateUrl: (name) => `http://127.0.0.1:7810/mcp/${name}`,
    credproxyUrl: "http://proxy",
    credproxyKey: "k",
    cliLogins: new CliLogins({}, async () => {}),
  });
  return { runner, sent, opened };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const turn = (turnId: string, input: string): ServerToRunner => ({
  type: "turn",
  turnId,
  source: "user",
  input,
  system: "",
  attachments: [],
});

describe("Runner", () => {
  it("runs turns in order once configured, and reopens on a model change", async () => {
    const { runner, sent, opened } = setup();
    runner.handle(turn("t1", "one"));
    await settle();
    expect(sent).toEqual([]);

    runner.handle({ type: "configure", config });
    runner.handle(turn("t2", "two"));
    await settle();
    expect(sent.filter((m) => m.type === "turn_end").map((m) => m.turnId)).toEqual(["t1", "t2"]);

    runner.handle({ type: "configure", config: { ...config, model: "claude-haiku-5-5" } });
    runner.handle(turn("t3", "three"));
    await settle();
    expect(opened).toEqual(["claude-opus-5-5:-", "claude-haiku-5-5:s2"]);
  });

  it("interrupts the running turn and drops a queued one", async () => {
    const { runner, sent } = setup();
    runner.handle({ type: "configure", config });
    runner.handle(turn("t1", "wait"));
    runner.handle(turn("t2", "queued"));
    await settle();
    runner.handle({ type: "interrupt", turnId: "t2" });
    runner.handle({ type: "interrupt", turnId: "t1" });
    await settle();
    const ends = sent.filter((m) => m.type === "turn_end");
    expect(ends.map((m) => [m.turnId, m.status])).toEqual([
      ["t2", "interrupted"],
      ["t1", "interrupted"],
    ]);
  });
});

describe("mcpServersFor", () => {
  it("adds ticked host servers, and reaches the gated ones through the guard by name", () => {
    const servers = mcpServersFor(
      { ...config, hostMcp: ["files"], gated: ["computer", "linear", "onepassword"] },
      {
        mcpServers: { nibblet: { type: "http", url: "http://server/mcp", headers: {} } },
        hostMcp: (name) => ({ type: "http", url: `http://server/hostmcp/${name}`, headers: {} }),
        gateUrl: (name) => `http://127.0.0.1:7810/mcp/${name}`,
      },
    );
    expect(Object.keys(servers).sort()).toEqual([
      "computer",
      "host_files",
      "linear",
      "nibblet",
      "onepassword",
    ]);
    expect(servers.host_files).toMatchObject({ url: "http://server/hostmcp/files" });
    // No settings or secrets, only an address on the guard's gate.
    expect(servers.onepassword).toEqual({
      type: "http",
      url: "http://127.0.0.1:7810/mcp/onepassword",
      headers: {},
    });
  });
});

describe("CliLogins", () => {
  it("sets and removes login env and runs setup only when a login changes", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    const ran: string[] = [];
    const logins = new CliLogins(env, async (cmd, args) => {
      ran.push([cmd, ...args].join(" "));
    });
    const gh = { id: "gh", env: { GH_TOKEN: "a" }, setup: [["gh", "auth", "setup-git"]] };
    await logins.apply([gh]);
    await logins.apply([gh]);
    expect(env.GH_TOKEN).toBe("a");
    expect(ran).toEqual(["gh auth setup-git"]);
    await logins.apply([{ ...gh, env: { GH_TOKEN: "b" } }]);
    expect(env.GH_TOKEN).toBe("b");
    expect(ran).toHaveLength(2);
    await logins.apply([]);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
