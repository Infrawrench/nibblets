import { defaultHamsterLook, type ActiveHours, type Nibblet } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import {
  heartbeatInput,
  isQuiet,
  locationAnswer,
  mayBeQuiet,
  recap,
  systemPrompt,
} from "./context.ts";
import { dueHeartbeat, withinActiveHours } from "./scheduler.ts";

const nibblet: Nibblet = {
  id: "nib_1",
  name: "Pip",
  look: defaultHamsterLook,
  harness: "claude",
  model: "claude-opus-5-5",
  effort: "medium",
  instructions: "Look after the deploys.",
  promptName: null,
  plain: false,
  parentId: null,
  status: "idle",
  statusDetail: null,
  resources: { cpus: null, memoryMb: null },
  monthlyBudgetUsd: null,
  snapshotPolicy: { everyMinutes: 1440, keep: 7 },
  heartbeats: [
    {
      name: "inbox",
      everyMinutes: 15,
      activeHours: null,
      checklist: "Anything urgent?",
      lastRunAt: null,
    },
  ],
  machine: { backend: "docker", guest: "linux" },
  browser: true,
  hostTools: [],
  cliCredentials: [],
  mcpServers: [],
  toolApprovals: [],
  tailscale: null,
  tailnetNode: null,
  spendingLimits: [],
  location: null,
  windowsProductKey: null,
  statusText: "Watching the deploy",
  statusEmoji: null,
  statusUpdatedAt: null,
  awaitingApproval: false,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  lastActivityAt: null,
};

describe("isQuiet", () => {
  it("only applies to turns nobody asked for", () => {
    expect(isQuiet("heartbeat", " NO_REPLY ")).toBe(true);
    expect(isQuiet("schedule", "Checked everything. NO_REPLY")).toBe(true);
    expect(isQuiet("user", "NO_REPLY")).toBe(false);
    expect(isQuiet("heartbeat", "The deploy failed!")).toBe(false);
  });

  it("applies to a sub-agent's result and to carrying on after a restart", () => {
    expect(isQuiet("subagent", "NO_REPLY")).toBe(true);
    expect(isQuiet("system", "NO_REPLY")).toBe(true);
    expect(isQuiet("subagent", "5 of 8 mockups are done.")).toBe(false);
  });
});

describe("mayBeQuiet", () => {
  it("holds back a reply that's still spelling out NO_REPLY", () => {
    expect(mayBeQuiet("subagent", "NO")).toBe(true);
    expect(mayBeQuiet("heartbeat", "NO_REP")).toBe(true);
    expect(mayBeQuiet("heartbeat", "NO_REPLY")).toBe(true);
    expect(mayBeQuiet("heartbeat", "Nothing urgent, but")).toBe(false);
    expect(mayBeQuiet("user", "NO")).toBe(false);
  });
});

describe("withinActiveHours", () => {
  const at = new Date("2026-10-13T12:30:00Z"); // 13:30 in London (BST)
  it("handles ordinary windows in the given timezone", () => {
    expect(withinActiveHours({ start: "09:00", end: "17:00", timezone: "Europe/London" }, at)).toBe(
      true,
    );
    expect(withinActiveHours({ start: "14:00", end: "17:00", timezone: "Europe/London" }, at)).toBe(
      false,
    );
  });
  it("handles windows that wrap past midnight", () => {
    expect(withinActiveHours({ start: "22:00", end: "06:00", timezone: "UTC" }, at)).toBe(false);
    expect(
      withinActiveHours(
        { start: "22:00", end: "06:00", timezone: "UTC" },
        new Date("2026-10-13T23:00:00Z"),
      ),
    ).toBe(true);
  });
  it("treats no window as always", () => {
    expect(withinActiveHours(null, at)).toBe(true);
  });
});

describe("systemPrompt", () => {
  const base = {
    serverName: "home",
    memories: [],
    history: null,
    parent: null,
    now: new Date("2026-10-21T12:00:00Z"),
  };
  const banks = [
    { id: "slash", label: "Slash", asset: { code: "USD", decimals: 2 } },
    { id: "bitcoin", label: "Bitcoin", asset: { code: "BTC", decimals: 8 } },
  ];

  it("adds what the user set for every nibblet, after its own instructions", () => {
    const prompt = systemPrompt({ ...base, nibblet, extra: "  Write in British English.\n" });
    expect(prompt).toContain(
      "## From the user, for every nibblet on this server\n\nThe user set this in the server's settings; it isn't yours to change.\n\nWrite in British English.\n\n## How you work",
    );
    expect(prompt.indexOf("Look after the deploys.")).toBeLessThan(
      prompt.indexOf("Write in British English."),
    );
    expect(systemPrompt({ ...base, nibblet: { ...nibblet, plain: true }, extra: "x" })).toContain(
      "## From the user, for every agent on this server",
    );
  });

  it("adds nothing when the user set nothing", () => {
    for (const extra of [undefined, "", "  \n"]) {
      expect(systemPrompt({ ...base, nibblet, extra })).not.toContain("## From the user");
    }
  });

  it("tells a nibblet what it may spend, and where", () => {
    const prompt = systemPrompt({
      ...base,
      nibblet: {
        ...nibblet,
        spendingLimits: [
          { asset: "USD", amount: "5000", period: "month" },
          { asset: "BTC", amount: "100000", period: "total" },
          // No bank deals in this one, so it isn't mentioned.
          { asset: "ETH", amount: "1", period: "day" },
        ],
      },
      banks,
    });
    expect(prompt).toContain("## Spending");
    expect(prompt).toContain("- 50.00 USD a month (UTC), from `slash`");
    expect(prompt).toContain("- 0.001 BTC in total, from `bitcoin`");
    expect(prompt).not.toContain("ETH");
    expect(prompt).toContain("`card_kill`");
  });

  it("says nothing about spending without a limit or a bank", () => {
    expect(systemPrompt({ ...base, nibblet, banks })).not.toContain("## Spending");
    const limited = {
      ...nibblet,
      spendingLimits: [{ asset: "USD", amount: "1", period: "day" as const }],
    };
    expect(systemPrompt({ ...base, nibblet: limited, banks: [] })).not.toContain("## Spending");
  });

  it("tells a nibblet which apps it's linked to, with its scopes", () => {
    const prompt = systemPrompt({
      ...base,
      nibblet,
      apps: [
        {
          name: "infrawrench",
          title: "Infrawrench",
          account: "Acme on Infrawrench",
          scopes: ["resources:read", "secrets:read"],
          providers: ["aws"],
          prompt: "Infrawrench's tools act there as you.",
        },
      ],
    });
    expect(prompt).toContain(
      "- Infrawrench, as Acme on Infrawrench, through the `infrawrench` tools. Your scopes: resources:read, secrets:read (only for aws).",
    );
    expect(prompt).toContain("Infrawrench's tools act there as you.");
    expect(systemPrompt({ ...base, nibblet, apps: [] })).not.toContain("## Linked apps");
  });

  const london = {
    latitude: 51.52461,
    longitude: -0.07813,
    accuracyM: 35,
    timeZone: "Europe/London",
    place: {
      neighbourhood: "Shoreditch",
      city: "London",
      region: "England",
      postcode: "E2 7DG",
      country: "United Kingdom",
      countryCode: "GB",
    },
    sharedAt: "2026-10-20T08:00:00.000Z",
  };

  it("points it at location_get once its person has shared where they are", () => {
    const prompt = systemPrompt({ ...base, nibblet, location: true });
    expect(prompt).toContain("## Where your person is");
    expect(prompt).toContain("call `location_get`, which asks their device");
    // The location itself only comes from the tool.
    expect(prompt).not.toContain("London");
    expect(prompt).not.toContain("51.5");
  });

  it("says nothing about a location nobody shared", () => {
    expect(systemPrompt({ ...base, nibblet })).not.toContain("## Where your person is");
    expect(systemPrompt({ ...base, nibblet, location: false })).not.toContain("location_get");
  });

  it("answers location_get with the place, and the time there now", () => {
    // Noon UTC is one in the afternoon in London, in BST.
    const answer = locationAnswer(london, new Date("2026-10-21T12:00:00Z"));
    expect(answer).toMatchObject({
      place: "Shoreditch, London, England, United Kingdom",
      city: "London",
      postcode: "E2 7DG",
      countryCode: "GB",
      latitude: 51.5246,
      longitude: -0.0781,
      accuracyMetres: 35,
      timeZone: "Europe/London",
      sharedAt: "2026-10-20T08:00:00.000Z",
    });
    expect(answer.localTime).toMatch(/^Wednesday 21 October.* 13:00 BST$/);
    expect(answer.fresh).toBe(true);
    expect(answer.note).toBe("Their device gave this just now.");
  });

  it("says why an answer is where they last were, not where they are", () => {
    const answer = locationAnswer(
      london,
      new Date("2026-10-21T12:00:00Z"),
      "No Nibblets was open on their devices to ask, so this is where they last shared.",
    );
    expect(answer.fresh).toBe(false);
    expect(answer.note).toContain("No Nibblets was open");
    expect(answer.note).toContain("They may have moved since");
  });

  it("says what's missing when the place or time zone couldn't be had", () => {
    const answer = locationAnswer(
      { ...london, place: null, timeZone: null },
      new Date("2026-10-21T12:00:00Z"),
    );
    expect(answer.place).toBeNull();
    expect(answer).not.toHaveProperty("city");
    expect(answer.localTime).toBeNull();
    expect(answer.note).toContain("work it out from the coordinates");
    expect(answer.note).toContain("didn't say its time zone");
  });

  it("includes instructions, memories, recap, and the browser rule", () => {
    const prompt = systemPrompt({
      nibblet,
      serverName: "home",
      memories: [
        {
          id: "mem_1",
          nibbletId: null,
          sharedBy: null,
          content: "Prefers tea",
          tags: [],
          createdAt: "",
          score: 0.9,
        },
      ],
      history: [
        {
          type: "user_message",
          id: "m1",
          turnId: "t1",
          createdAt: "",
          text: "Hello",
          source: "user",
        },
        {
          type: "assistant_message",
          id: "a1",
          turnId: "t1",
          createdAt: "",
          text: "Hi!",
          streaming: false,
        },
      ],
      parent: null,
      now: new Date("2026-10-13T12:00:00Z"),
    });
    expect(prompt).toContain("Look after the deploys.");
    expect(prompt).toContain("(mem_1, shared) Prefers tea");
    expect(prompt).toContain("[user] Hello");
    expect(prompt).toContain("[you] Hi!");
    expect(prompt).toContain("computer");
  });

  it("calls it by another name, or none, so its own never reaches the model", () => {
    const base = { serverName: "home", memories: [], history: null, parent: null };
    const now = new Date("2026-10-13T12:00:00Z");
    expect(systemPrompt({ ...base, now, nibblet })).toContain("You are Pip, a nibblet");
    const other = systemPrompt({ ...base, now, nibblet: { ...nibblet, promptName: "Ops" } });
    expect(other).toContain("You are Ops, a nibblet");
    expect(other).not.toContain("Pip");
    const none = systemPrompt({ ...base, now, nibblet: { ...nibblet, promptName: "" } });
    expect(none).toContain("You are a nibblet");
    expect(none).not.toContain("Pip");
  });

  it("doesn't name a sub-agent's parent when the parent isn't to know its own name", () => {
    const base = { serverName: "home", memories: [], history: null, now: new Date() };
    const child = { ...nibblet, id: "nib_2", name: "Scout", parentId: "nib_1" };
    expect(systemPrompt({ ...base, nibblet: child, parent: nibblet })).toContain(
      "sent back to Pip as your result",
    );
    const hidden = systemPrompt({
      ...base,
      nibblet: child,
      parent: { ...nibblet, promptName: "" },
    });
    expect(hidden).toContain("You are a sub-agent of another agent. You run in its container");
    expect(hidden).not.toContain("Pip");
  });

  it("leaves out the hamster and the cute stuff when plain", () => {
    const base = { serverName: "home", memories: [], history: null, parent: null, now: new Date() };
    const playful = systemPrompt({ ...base, nibblet: { ...nibblet, statusEmoji: "🐹" } });
    expect(playful).toContain("hamster");
    expect(playful).toContain("🐹 Watching the deploy");
    const plain = systemPrompt({
      ...base,
      nibblet: { ...nibblet, plain: true, statusEmoji: "🐹" },
    });
    expect(plain).toContain("You are Pip, a long-running personal agent");
    expect(plain).not.toMatch(/hamster|nibblet|🐹/i);
    expect(plain).toContain("no emoji");
  });

  it("tells it about the desktop and its apps only when it has one", () => {
    const base = { nibblet, serverName: "home", memories: [], history: null, parent: null };
    const now = new Date("2026-10-13T12:00:00Z");
    expect(systemPrompt({ ...base, now })).not.toContain("app_launch");
    const prompt = systemPrompt({ ...base, now, desktop: true });
    expect(prompt).toContain("`app_list`");
    expect(prompt).toContain("`desktop` tools");
    expect(prompt).toContain("~/.local/share/applications");
  });

  it("names its machine, and its guest's browser and apps", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    const base = { serverName: "home", memories: [], history: null, parent: null, now };
    const container = systemPrompt({ ...base, nibblet, desktop: true });
    expect(container).toContain("its own Docker container");
    expect(container).toContain("app `chromium`");

    const windows: Nibblet = { ...nibblet, machine: { backend: "hyperv", guest: "windows" } };
    const vm = systemPrompt({ ...base, nibblet: windows, desktop: true });
    expect(vm).toContain("its own Windows virtual machine");
    expect(vm).toContain("Microsoft Edge");
    expect(vm).toContain("msedge.exe");
    expect(vm).toContain("signed in as you");
    expect(vm).not.toContain("container");
    expect(vm).not.toContain("AppImages");
  });

  it("tells it where it is on the tailnet, what's shared, and how to reach out", () => {
    const base = { nibblet, serverName: "home", memories: [], history: null, parent: null };
    const now = new Date("2026-10-13T12:00:00Z");
    expect(systemPrompt({ ...base, now })).not.toContain("## Tailscale");
    const prompt = systemPrompt({
      ...base,
      now,
      tailnet: {
        node: {
          state: "running",
          dnsName: "pip.tail1234.ts.net",
          ips: ["100.64.0.7"],
          tailnet: "example.com",
          detail: null,
        },
        ports: [3000, 8080],
      },
    });
    expect(prompt).toContain("## Tailscale");
    expect(prompt).toContain("http://pip.tail1234.ts.net:3000");
    expect(prompt).toContain("ports 3000, 8080");
    expect(prompt).toContain("127.0.0.1:1055");
  });

  it("skips streaming replies in recaps", () => {
    expect(
      recap([
        {
          type: "assistant_message",
          id: "a",
          turnId: null,
          createdAt: "",
          text: "partial",
          streaming: true,
        },
      ]),
    ).toBe("");
  });
});

describe("dueHeartbeat", () => {
  const created = new Date("2026-10-13T08:00:00Z");
  const now = new Date("2026-10-13T12:00:00Z");
  const beat = (
    name: string,
    everyMinutes: number,
    lastRunAt: string | null,
    hours: ActiveHours | null = null,
  ) => ({
    name,
    everyMinutes,
    activeHours: hours,
    checklist: "",
    lastRunAt,
  });

  it("picks the most overdue heartbeat that's due", () => {
    const due = dueHeartbeat(
      [
        beat("inbox", 15, "2026-10-13T11:50:00Z"),
        beat("deploys", 60, "2026-10-13T10:30:00Z"),
        beat("news", 30, "2026-10-13T11:00:00Z"),
      ],
      created,
      now,
    );
    expect(due?.name).toBe("deploys");
  });

  it("waits from creation when a heartbeat has never run", () => {
    expect(dueHeartbeat([beat("a", 600, null)], created, now)).toBeNull();
    expect(dueHeartbeat([beat("a", 60, null)], created, now)?.name).toBe("a");
  });

  it("respects each heartbeat's own active hours", () => {
    const hours = { start: "14:00", end: "18:00", timezone: "UTC" };
    expect(dueHeartbeat([beat("a", 5, null, hours)], created, now)).toBeNull();
  });
});

describe("heartbeatInput", () => {
  it("names the heartbeat and carries its checklist", () => {
    const text = heartbeatInput({
      name: "inbox",
      everyMinutes: 15,
      activeHours: null,
      checklist: "Anything urgent?",
      lastRunAt: null,
    });
    expect(text).toContain('"inbox" heartbeat');
    expect(text).toContain("Anything urgent?");
  });
});
