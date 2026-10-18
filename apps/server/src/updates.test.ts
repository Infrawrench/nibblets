import { describe, expect, it } from "vitest";
import { AppUpdater, HarnessUpdater, latestOnNpm } from "./updates.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function npm(versions: Record<string, string>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const pkg = decodeURIComponent(
      url.replace("https://registry.npmjs.org/", "").replace("/latest", ""),
    );
    const version = versions[pkg];
    return version ? json({ version }) : json({}, 404);
  };
}

function setup(installed: Record<string, string | null> = {}) {
  const calls: string[][] = [];
  const state: Record<string, { bundled: string; installed: string | null }> = {
    claude: { bundled: "2.1.296", installed: installed.claude ?? null },
    codex: { bundled: "0.162.1", installed: installed.codex ?? null },
    kimi: { bundled: "2.2.0", installed: installed.kimi ?? null },
    opencode: { bundled: "1.19.0", installed: installed.opencode ?? null },
  };
  const settings = new Map<string, unknown>();
  const updater = new HarnessUpdater({
    store: {
      getSetting: async (key, parse, fallback) =>
        settings.has(key) ? parse(settings.get(key)) : fallback,
      setSetting: async (key, value) => void settings.set(key, value),
    },
    docker: {
      harnessCli: async (args) => {
        calls.push(args);
        const [command, id, version] = args;
        if (command === "install" && id && version)
          state[id] = { ...state[id]!, installed: version };
        if (command === "bundled" && id) state[id] = { ...state[id]!, installed: null };
        return command === "versions" ? state : {};
      },
    },
    fetch: npm({
      "@anthropic-ai/claude-code": "2.1.299",
      "@openai/codex": "0.162.1",
      "@moonshot-ai/kimi-code": "2.2.0",
      "opencode-ai": "1.19.0",
    }),
  });
  return { updater, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("latestOnNpm", () => {
  it("asks for scoped packages with the slash encoded", async () => {
    let asked = "";
    await latestOnNpm("@openai/codex", async (input) => {
      asked = String(input);
      return json({ version: "1.0.0" });
    });
    expect(asked).toBe("https://registry.npmjs.org/@openai%2Fcodex/latest");
  });
});

describe("HarnessUpdater", () => {
  it("reports what's built in, installed, and newest", async () => {
    const { updater } = setup();
    const status = await updater.check();
    expect(status.auto).toBe(true);
    expect(status.harnesses.find((h) => h.id === "claude")).toMatchObject({
      bundled: "2.1.296",
      installed: null,
      latest: "2.1.299",
      updating: false,
    });
  });

  it("installs only what's behind", async () => {
    const { updater, calls } = setup();
    await updater.check();
    await updater.update();
    await settle();
    expect(calls.filter((c) => c[0] === "install")).toEqual([["install", "claude", "2.1.299"]]);
    const status = await updater.status();
    expect(status.harnesses.find((h) => h.id === "claude")?.installed).toBe("2.1.299");
  });

  it("leaves an installed release alone once it's the newest", async () => {
    const { updater, calls } = setup({ claude: "2.1.299" });
    await updater.update();
    await settle();
    expect(calls.some((c) => c[0] === "install")).toBe(false);
  });

  it("goes back to the bundled CLI", async () => {
    const { updater } = setup({ claude: "2.1.299" });
    const status = await updater.useBundled("claude");
    expect(status.harnesses.find((h) => h.id === "claude")?.installed).toBeNull();
  });

  it("keeps DeepSeek's Claude Code under Claude", async () => {
    const { updater, calls } = setup();
    expect((await updater.status()).harnesses.map((h) => h.id)).not.toContain("deepseek");
    await updater.update("deepseek");
    await settle();
    expect(calls).toContainEqual(["install", "claude", "2.1.299"]);
    await updater.useBundled("deepseek");
    expect(calls).toContainEqual(["bundled", "claude"]);
  });

  it("remembers when automatic updates are off", async () => {
    const { updater } = setup();
    expect((await updater.setAuto(false)).auto).toBe(false);
  });
});

describe("AppUpdater", () => {
  const config = { HOST_MCP_URL: "http://bridge", HOST_MCP_TOKEN: "t", NIBBLET_UPDATE_REPO: "o/r" };
  const release = {
    tag_name: "v0.2.0",
    name: "Nibblets 0.2.0",
    body: "- Updates",
    html_url: "https://github.com/o/r/releases/tag/v0.2.0",
    published_at: "2026-10-14T00:00:00Z",
  };

  it("offers a newer release, installed here when the bridge can", async () => {
    const updater = new AppUpdater({
      config,
      version: "0.1.0",
      fetch: async (input) =>
        String(input).startsWith("http://bridge") ? json({ method: "here" }) : json(release),
    });
    expect(await updater.status()).toMatchObject({
      current: "0.1.0",
      available: true,
      method: "here",
      latest: { version: "0.2.0", notes: "- Updates" },
    });
  });

  it("offers nothing when there are no releases, and falls back to manual without a bridge", async () => {
    const updater = new AppUpdater({
      config: { ...config, HOST_MCP_URL: "" },
      version: "0.1.0",
      fetch: async () => json({ message: "Not Found" }, 404),
    });
    expect(await updater.status()).toMatchObject({
      available: false,
      latest: null,
      method: "manual",
      error: null,
    });
  });

  it("isn't fooled by an older release", async () => {
    const updater = new AppUpdater({
      config,
      version: "0.3.0",
      fetch: async (input) =>
        String(input).startsWith("http://bridge") ? json({ method: "here" }) : json(release),
    });
    expect((await updater.status()).available).toBe(false);
  });

  it("pauses the nibblets before updating, and lets them carry on if it fails", async () => {
    const events: string[] = [];
    let bridgeState: { method: "here"; updating: boolean; error: string | null } = {
      method: "here",
      updating: false,
      error: null,
    };
    const updater = new AppUpdater({
      config,
      version: "0.1.0",
      pause: async () => void events.push("pause"),
      unpause: async () => void events.push("unpause"),
      fetch: async (input, init) => {
        if (!String(input).startsWith("http://bridge")) return json(release);
        if (init?.method === "POST") {
          events.push("install");
          bridgeState = { ...bridgeState, updating: true };
        }
        return json(bridgeState);
      },
    });
    await updater.status();
    await updater.apply();
    expect(events).toEqual(["pause", "install"]);

    // Still going: nothing changes.
    await updater.status();
    expect(events).toEqual(["pause", "install"]);

    // It failed without restarting anything.
    bridgeState = { method: "here", updating: false, error: "Couldn't download it" };
    expect((await updater.status()).updating).toBe(false);
    expect(events).toEqual(["pause", "install", "unpause"]);
  });

  it("lets the nibblets carry on when the host comes back without the update", async () => {
    const events: string[] = [];
    let now = 0;
    let bridge: { method: "here"; updating: boolean } | null = { method: "here", updating: false };
    const updater = new AppUpdater({
      config,
      version: "0.1.0",
      now: () => now,
      pause: async () => void events.push("pause"),
      unpause: async () => void events.push("unpause"),
      fetch: async (input, init) => {
        if (!String(input).startsWith("http://bridge")) return json(release);
        if (init?.method === "POST") bridge = { method: "here", updating: true };
        return bridge ? json(bridge) : json({ error: "gone" }, 502);
      },
    });
    await updater.apply();
    // The app quits to install it, then is opened again before it could.
    bridge = null;
    now = 60_000;
    expect((await updater.status()).updating).toBe(true);
    bridge = { method: "here", updating: false };
    expect((await updater.status()).updating).toBe(true);
    now = 4 * 60_000;
    expect((await updater.status()).updating).toBe(false);
    expect(events).toEqual(["pause", "unpause"]);
  });

  it("lets the nibblets carry on when the bridge won't take the update", async () => {
    const events: string[] = [];
    const updater = new AppUpdater({
      config,
      version: "0.1.0",
      pause: async () => void events.push("pause"),
      unpause: async () => void events.push("unpause"),
      fetch: async (input, init) => {
        if (!String(input).startsWith("http://bridge")) return json(release);
        return init?.method === "POST" ? json({ error: "busy" }, 409) : json({ method: "here" });
      },
    });
    await expect(updater.apply()).rejects.toThrow(/didn't take/);
    expect(events).toEqual(["pause", "unpause"]);
  });
});
