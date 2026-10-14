import {
  RpcError,
  contract,
  createDispatcher,
  defaultHamsterLook,
  defaultSnapshotPolicy,
  harnesses,
  opencodeModel,
  maskMcpServers,
  mergeMcpServers,
  randomHamsterLook,
  type Contract,
  type OnePasswordGrants,
  type HostTool,
  type McpServerDef,
  type Handlers,
  type LiveMessage,
  type Memory,
  type Nibblet,
  type ConnectStatus,
  type Schedule,
  type Snapshot,
  type SnapshotActivity,
  type StoredItem,
  type ThreadItem,
  type TailscaleStatus,
  type AppUpdate,
  type HarnessUpdates,
} from "@nibblet/protocol";
import {
  createMockConnection,
  type LiveFeed,
  type LiveState,
  type ServerConnection,
} from "./connection.ts";
import type { FileRef } from "@nibblet/protocol";
import { mockFileRef, registerMockFile } from "./files.ts";

/** What a host's OpenCode might offer: Zen's free models and a couple of its own providers. */
const mockOpencodeModels = [
  { id: "opencode/big-pickle", provider: "opencode", name: "Big Pickle" },
  { id: "opencode/space-bunny-free", provider: "opencode", name: "Space Bunny (free)" },
  { id: "neon/claude-opus-5-5", provider: "neon", name: "Claude Opus 5.5" },
  { id: "neon/gpt-5-3-codex", provider: "neon", name: "GPT-5.3 Codex" },
  {
    id: "my-friends-apartment/qwen3.6:27b",
    provider: "my-friends-apartment",
    name: "Qwen 3.6 27B",
  },
].map(opencodeModel);

const mockHostTools: HostTool[] = [
  {
    name: "filesystem",
    source: "Claude Desktop",
    transport: "stdio",
    status: "ready",
    detail: null,
    fingerprint: "mock-1",
    tools: [
      { name: "read_file", description: "Read a file" },
      { name: "write_file", description: "Write a file" },
      { name: "list_directory", description: "List a directory" },
    ],
  },
  {
    name: "linear",
    source: "Claude Code",
    transport: "http",
    status: "ready",
    detail: null,
    fingerprint: "mock-2",
    tools: [
      { name: "list_issues", description: "List issues" },
      { name: "create_issue", description: "Create an issue" },
    ],
  },
  {
    name: "postgres",
    source: "Nibblets",
    transport: "stdio",
    status: "error",
    detail: "connection refused",
    fingerprint: "mock-3",
    tools: [],
  },
];

/**
 * An in-memory server for `?mock`, so the UI can be worked on (and
 * screenshotted) without Docker. It implements the real contract through
 * the real dispatcher, so mock and server can't drift apart silently.
 */
export function createMockServer(): ServerConnection {
  const listeners = new Set<(m: LiveMessage) => void>();
  const push = (m: LiveMessage) => listeners.forEach((l) => l(m));
  let seq = 0;
  const now = () => new Date().toISOString();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  // Like the server: secrets kept here, masked in everything handed out.
  const secrets = new Map<string, McpServerDef[]>();
  const keepSecrets = (id: string, servers: McpServerDef[]) => {
    secrets.set(id, servers);
    return maskMcpServers(servers);
  };

  const nibblet = (partial: Partial<Nibblet> & Pick<Nibblet, "id" | "name">): Nibblet => ({
    look: defaultHamsterLook,
    harness: "claude",
    model: harnesses.claude.defaultModel,
    effort: "medium",
    instructions: "",
    parentId: null,
    status: "idle",
    statusDetail: null,
    resources: { cpus: null, memoryMb: null },
    snapshotPolicy: defaultSnapshotPolicy,
    heartbeats: [
      {
        name: "inbox",
        everyMinutes: 15,
        activeHours: { start: "08:00", end: "19:00", timezone: "Europe/London" },
        checklist: "Anything urgent in the work inbox or calendar?",
        lastRunAt: null,
      },
      {
        name: "flights",
        everyMinutes: 120,
        activeHours: null,
        checklist: "Has the Lisbon fare dropped below £80?",
        lastRunAt: null,
      },
    ],
    browser: true,
    hostTools: [],
    cliCredentials: [],
    mcpServers: [],
    toolApprovals: [],
    statusText: null,
    statusEmoji: null,
    statusUpdatedAt: null,
    awaitingApproval: false,
    createdAt: ago(60 * 24 * 3),
    updatedAt: ago(5),
    lastActivityAt: ago(5),
    ...partial,
  });

  const nibblets = new Map<string, Nibblet>(
    [
      nibblet({
        id: "pip",
        name: "Pip",
        status: "working",
        statusText: "Hunting for a cheap flight to Lisbon",
        statusEmoji: "✈️",
        statusUpdatedAt: ago(3),
        instructions:
          "Look after my inbox and calendar. Summarise anything important each morning.",
        look: { ...defaultHamsterLook, accessory: "headphones", accessoryColour: "teal" },
      }),
      nibblet({
        id: "pip-research",
        name: "Flight research",
        parentId: "pip",
        status: "working",
        statusText: "Comparing Gatwick fares",
        statusUpdatedAt: ago(2),
        look: {
          ...defaultHamsterLook,
          fur: "cream",
          pattern: "solid",
          ears: "tiny",
          background: "mint",
        },
      }),
      nibblet({
        id: "biscuit",
        name: "Biscuit",
        harness: "codex",
        model: harnesses.codex.defaultModel,
        status: "working",
        statusText: "Waiting on you to approve a payment",
        statusEmoji: "💸",
        statusUpdatedAt: ago(1),
        awaitingApproval: true,
        hostTools: ["mercury"],
        toolApprovals: [{ server: "host_mercury", tool: "*pay*" }],
        look: {
          ...defaultHamsterLook,
          fur: "cinnamon",
          pattern: "patches",
          eyes: "sparkle",
          cheeks: "stuffed",
          accessory: "party_hat",
          accessoryColour: "pink",
          background: "peach",
        },
      }),
      nibblet({
        id: "mochi",
        name: "Mochi",
        harness: "opencode",
        model: "opencode/big-pickle",
        status: "stopped",
        look: {
          ...defaultHamsterLook,
          fur: "grey",
          pattern: "roan",
          eyes: "dot",
          accessory: "beanie",
          accessoryColour: "purple",
          background: "lavender",
        },
      }),
      nibblet({
        id: "toffee",
        name: "Toffee",
        status: "error",
        statusDetail: "The Claude credential has expired",
        look: {
          ...defaultHamsterLook,
          fur: "chocolate",
          belly: "cream",
          accessory: "glasses",
          accessoryColour: "red",
          background: "rose",
        },
      }),
    ].map((n) => [n.id, n]),
  );

  const items = new Map<string, StoredItem[]>();
  const store = (nibbletId: string, item: ThreadItem) => {
    const list = items.get(nibbletId) ?? [];
    const stored: StoredItem = { nibbletId, seq: ++seq, item };
    const i = list.findIndex((s) => s.item.id === item.id);
    if (i >= 0) list[i] = stored;
    else list.push(stored);
    items.set(nibbletId, list);
    push({ type: "item", item: stored });
  };

  // Snapshots keep a copy of the thread; the mock has no disk to copy.
  const snapshots = new Map<string, { snapshot: Snapshot; thread: ThreadItem[]; maxSeq: number }>();
  const positions = new Map<string, { snapshotId: string; maxSeq: number }>();
  const activity = new Map<string, NonNullable<SnapshotActivity>>();
  const threadMax = (nibbletId: string) =>
    Math.max(0, ...(items.get(nibbletId) ?? []).map((s) => s.seq));
  const setActivity = (nibbletId: string, a: SnapshotActivity) => {
    if (a) activity.set(nibbletId, a);
    else activity.delete(nibbletId);
    push({ type: "snapshots_changed", nibbletId, activity: a });
  };
  const takeSnapshot = (
    nibbletId: string,
    trigger: Snapshot["trigger"],
    label: string | null,
  ): Snapshot => {
    const thread = (items.get(nibbletId) ?? []).map((s) => s.item);
    const snapshot: Snapshot = {
      id: crypto.randomUUID(),
      nibbletId,
      createdAt: now(),
      label,
      trigger,
      sizeBytes: 40_000_000 + thread.length * 2_000,
      messageCount: thread.filter(
        (i) => i.type === "user_message" || i.type === "assistant_message",
      ).length,
    };
    snapshots.set(snapshot.id, { snapshot, thread, maxSeq: threadMax(nibbletId) });
    return snapshot;
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A thread with one of everything, for Pip.
  const t1 = "turn-1";
  const seed: ThreadItem[] = [
    {
      type: "user_message",
      id: "u1",
      turnId: t1,
      createdAt: ago(42),
      text: "Can you find me a cheap flight to Lisbon for the first weekend of November?",
      source: "user",
    },
    {
      type: "turn",
      id: t1,
      turnId: null,
      createdAt: ago(42),
      source: "user",
      status: "completed",
      quiet: false,
      usage: { inputTokens: 21000, outputTokens: 900, cachedInputTokens: 18000 },
      endedAt: ago(38),
    },
    {
      type: "reasoning",
      id: "r1",
      turnId: t1,
      createdAt: ago(41.9),
      text: "I should check the user's saved preferences first, then hand the price comparison to a sub-agent so I can keep watching the inbox.",
      streaming: false,
    },
    {
      type: "tool_call",
      id: "tc1",
      turnId: t1,
      createdAt: ago(41.8),
      name: "memory_search",
      server: "nibblet",
      input: { query: "travel preferences airline seat" },
      output:
        "1. Prefers aisle seats, hates early flights before 8am (saved 12 Sep)\n2. Home airport: LGW",
      status: "done",
    },
    {
      type: "subagent",
      id: "sa1",
      turnId: t1,
      createdAt: ago(41.5),
      childId: "pip-research",
      task: "Compare fares LGW→LIS, 31 Oct to 2 Nov, no departures before 8am",
      status: "running",
      result: null,
    },
    {
      type: "assistant_message",
      id: "a1",
      turnId: t1,
      createdAt: ago(41),
      text: "I've got a sub-agent comparing fares from **Gatwick** for 31 October to 2 November, skipping anything before 8am like you prefer. I'll message you when it's done.",
      streaming: false,
    },
    {
      type: "user_message",
      id: "hb1",
      turnId: "turn-2",
      createdAt: ago(30),
      text: "Heartbeat: check the inbox and calendar.",
      source: "heartbeat",
    },
    {
      type: "turn",
      id: "turn-2",
      turnId: null,
      createdAt: ago(30),
      source: "heartbeat",
      status: "completed",
      quiet: true,
      usage: null,
      endedAt: ago(29),
    },
    {
      type: "user_message",
      id: "s1",
      turnId: "turn-3",
      createdAt: ago(10),
      text: "Morning summary (schedule)",
      source: "schedule",
    },
    {
      type: "turn",
      id: "turn-3",
      turnId: null,
      createdAt: ago(10),
      source: "schedule",
      status: "completed",
      quiet: false,
      usage: null,
      endedAt: ago(9),
    },
    {
      type: "tool_call",
      id: "tc2",
      turnId: "turn-3",
      createdAt: ago(9.8),
      name: "screenshot",
      server: "computer",
      input: { session_id: "s1-chromium" },
      output: "Captured 1280×800",
      status: "done",
    },
    {
      type: "assistant_message",
      id: "a2",
      turnId: "turn-3",
      createdAt: ago(9.5),
      text: "Good morning! Three things today:\n\n1. **Dentist** at 14:30, I've added travel time.\n2. Your landlord replied about the boiler; they can come Thursday.\n3. Nothing urgent in the work inbox.\n\n```\nnext check: 12:00\n```",
      streaming: false,
    },
    {
      type: "notice",
      id: "n1",
      turnId: "turn-3",
      createdAt: ago(9),
      level: "warning",
      text: "The browser session was restarted after Chromium stopped responding.",
    },
  ];
  for (const item of seed) store("pip", item);
  // A few snapshots to look at: automatic ones from before the thread got going, and one by hand.
  for (const [minutes, trigger, label, upTo] of [
    [60 * 24 * 2, "auto", null, 0],
    [60 * 24, "auto", null, 0],
    [41, "manual", "Before the flight search", 1],
  ] as const) {
    const s = takeSnapshot("pip", trigger, label);
    const kept = snapshots.get(s.id);
    if (kept) {
      kept.thread = seed.slice(0, upTo);
      kept.maxSeq = 0;
      kept.snapshot = {
        ...s,
        createdAt: ago(minutes),
        messageCount: upTo,
        sizeBytes: 38_000_000 + minutes * 1000,
      };
    }
  }
  store("biscuit", {
    type: "user_message",
    id: "b1",
    turnId: "tb",
    createdAt: ago(200),
    text: "Keep an eye on the CI for nibblet and tell me if main goes red.",
    source: "user",
  });
  store("biscuit", {
    type: "assistant_message",
    id: "b2",
    turnId: "tb",
    createdAt: ago(199),
    text: "Will do. I've set a schedule to check every 15 minutes.",
    streaming: false,
  });
  store("biscuit", {
    type: "tool_call",
    id: "b3",
    turnId: "tb2",
    createdAt: ago(2),
    name: "status_set",
    server: "nibblet",
    input: { text: "Waiting on you to approve a payment", emoji: "💸" },
    output: "Status set.",
    status: "done",
  });
  store("biscuit", {
    type: "approval",
    id: "b4",
    turnId: "tb2",
    createdAt: ago(1),
    server: "host_mercury",
    tool: "create_payment",
    input: { to: "Hetzner Online GmbH", amount: 42.5, currency: "EUR", memo: "October servers" },
    status: "pending",
    reason: null,
    decidedAt: null,
  });

  const schedules = new Map<string, Schedule>([
    [
      "sc1",
      {
        id: "sc1",
        nibbletId: "pip",
        name: "Morning summary",
        cron: "0 8 * * 1-5",
        runAt: null,
        timezone: "Europe/London",
        prompt: "Summarise my inbox and today's calendar.",
        enabled: true,
        nextRunAt: ago(-60 * 14),
        lastRunAt: ago(10),
        createdAt: ago(5000),
      },
    ],
    [
      "sc2",
      {
        id: "sc2",
        nibbletId: "pip",
        name: "Remind me about the passport",
        cron: null,
        runAt: ago(-60 * 24 * 4),
        timezone: "Europe/London",
        prompt: "Remind me to renew my passport.",
        enabled: true,
        nextRunAt: ago(-60 * 24 * 4),
        lastRunAt: null,
        createdAt: ago(800),
      },
    ],
  ]);
  const memories = new Map<string, Memory>([
    [
      "m1",
      {
        id: "m1",
        nibbletId: "pip",
        sharedBy: null,
        content: "Prefers aisle seats, hates early flights before 8am.",
        tags: ["travel"],
        createdAt: ago(60 * 24 * 30),
        score: null,
      },
    ],
    [
      "m2",
      {
        id: "m2",
        nibbletId: null,
        sharedBy: null,
        content: "Home airport is LGW. Lives in Brighton.",
        tags: ["travel", "home"],
        createdAt: ago(60 * 24 * 40),
        score: null,
      },
    ],
  ]);
  const CENTRAL = "https://nibblets-connect.example.workers.dev";
  let connect: ConnectStatus = { state: "unlinked", centralUrl: CENTRAL };
  let tailscale: TailscaleStatus = {
    installed: true,
    running: true,
    serving: false,
    url: null,
    detail: null,
    action: null,
  };
  let serverName = "Astrid's Mac mini";
  let harnessUpdates: HarnessUpdates = {
    auto: true,
    checkedAt: ago(42),
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        bundled: "2.1.296",
        installed: null,
        latest: "2.1.299",
        updating: false,
        error: null,
      },
      {
        id: "codex",
        label: "Codex",
        bundled: "0.162.1",
        installed: null,
        latest: "0.162.1",
        updating: false,
        error: null,
      },
      {
        id: "opencode",
        label: "OpenCode",
        bundled: "1.18.4",
        installed: "1.19.0",
        latest: "1.19.0",
        updating: false,
        error: null,
      },
    ],
  };
  let appUpdate: AppUpdate = {
    current: "0.1.0",
    latest: {
      version: "0.2.0",
      name: "Nibblets 0.2.0",
      notes:
        "- Agents keep themselves up to date\n- Podman works as well as Docker\n- Tidier dialogs",
      url: "https://github.com/Infrawrench/nibblets/releases/tag/v0.2.0",
      publishedAt: ago(60 * 5),
    },
    available: true,
    method: "here",
    updating: false,
    error: null,
    checkedAt: ago(10),
  };
  const setHarness = (id: string, patch: Partial<HarnessUpdates["harnesses"][number]>) => {
    harnessUpdates = {
      ...harnessUpdates,
      harnesses: harnessUpdates.harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    };
  };

  const get = (id: string) => {
    const n = nibblets.get(id);
    if (!n) throw new RpcError("not_found", `No nibblet ${id}`);
    return n;
  };
  const save = (n: Nibblet) => {
    nibblets.set(n.id, n);
    push({ type: "nibblet", nibblet: n });
    return n;
  };

  /** Plays a canned reply, streaming like the real thing. */
  /** Shares a little SVG, uploading over a second or so, so the card can be judged. */
  const mockShare = (id: string, turnId: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" rx="10" fill="#dce8f5"/><circle cx="60" cy="44" r="24" fill="#e9a95e"/><circle cx="44" cy="24" r="8" fill="#e9a95e"/><circle cx="76" cy="24" r="8" fill="#e9a95e"/><circle cx="52" cy="42" r="3"/><circle cx="68" cy="42" r="3"/></svg>`;
    const ref = registerMockFile(
      new Blob([svg], { type: "image/svg+xml" }),
      "hamster-sketch.svg",
      "image/svg+xml",
    );
    const base = {
      type: "file" as const,
      id: ref.fileId,
      turnId,
      createdAt: now(),
      ...ref,
      caption: "A quick sketch of me, for your records.",
      error: null,
    };
    let received = 0;
    const tick = () => {
      received = Math.min(ref.size, received + Math.ceil(ref.size / 6));
      const done = received >= ref.size;
      store(id, { ...base, status: done ? "ready" : "uploading", received });
      if (!done) setTimeout(tick, 220);
    };
    setTimeout(tick, 600);
  };

  const reply = (id: string, text: string, attachments: FileRef[] = []) => {
    const turnId = crypto.randomUUID();
    const started = now();
    store(id, {
      type: "user_message",
      id: crypto.randomUUID(),
      turnId,
      createdAt: started,
      text,
      source: "user",
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // Mention a file, or attach one, and the mock hamster shares a sketch back.
    if (attachments.length > 0 || /\bfiles?\b/i.test(text)) mockShare(id, turnId);
    store(id, {
      type: "turn",
      id: turnId,
      turnId: null,
      createdAt: started,
      source: "user",
      status: "running",
      quiet: false,
      usage: null,
      endedAt: null,
    });
    save({ ...get(id), status: "working" });
    const answer = `Sure! You said: "${text}". I'm a mock hamster, so this is all I can do, but the real one would get on with it.`;
    const msgId = crypto.randomUUID();
    const words = answer.split(" ");
    words.forEach((_, i) => {
      setTimeout(
        () => {
          store(id, {
            type: "assistant_message",
            id: msgId,
            turnId,
            createdAt: started,
            text: words.slice(0, i + 1).join(" "),
            streaming: i < words.length - 1,
          });
          if (i === words.length - 1) {
            store(id, {
              type: "turn",
              id: turnId,
              turnId: null,
              createdAt: started,
              source: "user",
              status: "completed",
              quiet: false,
              usage: null,
              endedAt: now(),
            });
            save({ ...get(id), status: "idle", lastActivityAt: now() });
          }
        },
        300 + i * 60,
      );
    });
  };

  const onePasswordGrants: OnePasswordGrants = {
    pip: [{ vaultId: "v-nibblets", access: "read" }],
  };
  const handlers: Handlers<Contract, null> = {
    system: {
      info: async () => ({
        serverId: "local",
        name: serverName,
        version: "0.1.0-mock",
        credentials: [
          {
            provider: "anthropic",
            source: "keychain",
            ok: true,
            detail: "Claude Max",
            plan: "max",
            expiresAt: ago(-120),
          },
          {
            provider: "openai",
            source: "file",
            ok: true,
            detail: "ChatGPT Pro",
            plan: "pro",
            expiresAt: ago(-60 * 24),
          },
        ],
        host: { cpus: 10, memoryMb: 16384 },
      }),
      rename: async ({ name }) => {
        serverName = name;
        return { ok: true };
      },
    },
    nibblets: {
      list: async () => [...nibblets.values()],
      get: async ({ id }) => get(id),
      create: async (input) => {
        const id = crypto.randomUUID().slice(0, 8);
        const n = save(
          nibblet({
            id,
            name: input.name,
            look: input.look ?? randomHamsterLook(),
            harness: input.harness,
            model: input.model,
            effort: input.effort,
            instructions: input.instructions,
            browser: input.browser,
            hostTools: input.hostTools,
            cliCredentials: input.cliCredentials,
            mcpServers: keepSecrets(id, input.mcpServers),
            toolApprovals: input.toolApprovals,
            heartbeats: [],
            resources: { cpus: null, memoryMb: null },
            status: "idle",
            createdAt: now(),
            lastActivityAt: now(),
          }),
        );
        if (input.message) reply(id, input.message);
        return n;
      },
      update: async ({ id, ...patch }) => {
        const current = get(id);
        return save({
          ...current,
          name: patch.name ?? current.name,
          look: patch.look ?? current.look,
          harness: patch.harness ?? current.harness,
          model: patch.model ?? current.model,
          effort: patch.effort ?? current.effort,
          instructions: patch.instructions ?? current.instructions,
          browser: patch.browser ?? current.browser,
          hostTools: patch.hostTools ?? current.hostTools,
          cliCredentials: patch.cliCredentials ?? current.cliCredentials,
          mcpServers: patch.mcpServers
            ? keepSecrets(id, mergeMcpServers(patch.mcpServers, secrets.get(id) ?? []))
            : current.mcpServers,
          toolApprovals: patch.toolApprovals ?? current.toolApprovals,
          resources: patch.resources ?? current.resources,
          snapshotPolicy: patch.snapshotPolicy ?? current.snapshotPolicy,
          updatedAt: now(),
        });
      },
      delete: async ({ id }) => {
        nibblets.delete(id);
        push({ type: "nibblet_deleted", id });
        return { ok: true };
      },
      start: async ({ id }) => save({ ...get(id), status: "idle", statusDetail: null }),
      stop: async ({ id }) => save({ ...get(id), status: "stopped" }),
      send: async ({ id, text, attachments }) => {
        reply(
          id,
          text,
          attachments.flatMap((a) => mockFileRef(a) ?? []),
        );
        return { ok: true };
      },
      interrupt: async ({ id }) => {
        save({ ...get(id), status: "idle" });
        return { ok: true };
      },
      wake: async () => ({ ok: true }),
      resume: async ({ id }) => {
        save({ ...get(id), status: "idle", statusDetail: null });
        return { ok: true };
      },
      decide: async ({ id, approvalId, approve, reason }) => {
        const found = items.get(id)?.find((s) => s.item.id === approvalId)?.item;
        if (found?.type === "approval" && found.status === "pending") {
          store(id, {
            ...found,
            status: approve ? "approved" : "denied",
            reason: reason ?? null,
            decidedAt: now(),
          });
        }
        save({ ...get(id), awaitingApproval: false });
        return { ok: true };
      },
    },
    thread: {
      items: async ({ nibbletId, sinceSeq }) =>
        (items.get(nibbletId) ?? []).filter((s) => s.seq > sinceSeq),
    },
    schedules: {
      list: async ({ nibbletId }) =>
        [...schedules.values()].filter((s) => s.nibbletId === nibbletId),
      create: async (input) => {
        const s: Schedule = {
          id: crypto.randomUUID(),
          ...input,
          enabled: true,
          nextRunAt: input.runAt,
          lastRunAt: null,
          createdAt: now(),
        };
        schedules.set(s.id, s);
        push({ type: "schedules_changed", nibbletId: s.nibbletId });
        return s;
      },
      setEnabled: async ({ id, enabled }) => {
        const s = schedules.get(id);
        if (!s) throw new RpcError("not_found", "No such schedule");
        const next = { ...s, enabled };
        schedules.set(id, next);
        return next;
      },
      delete: async ({ id }) => {
        schedules.delete(id);
        return { ok: true };
      },
    },
    memories: {
      list: async ({ nibbletId, query }) =>
        [...memories.values()]
          .filter((m) => m.nibbletId === null || m.nibbletId === nibbletId)
          .filter((m) => !query || m.content.toLowerCase().includes(query.toLowerCase()))
          .map((m) => ({ ...m, score: query ? 0.82 : null })),
      create: async ({ nibbletId, content, tags }) => {
        const m: Memory = {
          id: crypto.randomUUID(),
          nibbletId,
          sharedBy: null,
          content,
          tags,
          createdAt: now(),
          score: null,
        };
        memories.set(m.id, m);
        return m;
      },
      delete: async ({ id }) => {
        memories.delete(id);
        return { ok: true };
      },
    },
    snapshots: {
      list: async ({ nibbletId }) => {
        const position = positions.get(nibbletId);
        return {
          snapshots: [...snapshots.values()]
            .map((s) => s.snapshot)
            .filter((s) => s.nibbletId === nibbletId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          current:
            position && snapshots.has(position.snapshotId)
              ? {
                  snapshotId: position.snapshotId,
                  changedSince: threadMax(nibbletId) > position.maxSeq,
                }
              : null,
          activity: activity.get(nibbletId) ?? null,
        };
      },
      create: async ({ nibbletId, label }) => {
        setActivity(nibbletId, "snapshotting");
        await pause(800);
        const snapshot = takeSnapshot(nibbletId, "manual", label?.trim() || null);
        setActivity(nibbletId, null);
        return snapshot;
      },
      restore: async ({ id }) => {
        const target = snapshots.get(id);
        if (!target) throw new RpcError("not_found", "That snapshot doesn't exist");
        const nibbletId = target.snapshot.nibbletId;
        setActivity(nibbletId, "restoring");
        const name = target.snapshot.label
          ? `“${target.snapshot.label}”`
          : new Date(target.snapshot.createdAt).toLocaleString("en-GB");
        takeSnapshot(nibbletId, "before_restore", `Before restoring ${name}`);
        save({ ...get(nibbletId), status: "starting", statusDetail: "Restoring a snapshot…" });
        await pause(1500);
        items.set(
          nibbletId,
          target.thread.map((item) => ({ nibbletId, seq: ++seq, item })),
        );
        positions.set(nibbletId, { snapshotId: id, maxSeq: threadMax(nibbletId) });
        push({ type: "thread_reset", nibbletId });
        save({ ...get(nibbletId), status: "idle", statusDetail: null });
        setActivity(nibbletId, null);
        return { ok: true };
      },
      rename: async ({ id, label }) => {
        const found = snapshots.get(id);
        if (!found) throw new RpcError("not_found", "That snapshot doesn't exist");
        found.snapshot = { ...found.snapshot, label: label?.trim() || null };
        push({ type: "snapshots_changed", nibbletId: found.snapshot.nibbletId, activity: null });
        return found.snapshot;
      },
      delete: async ({ id }) => {
        const found = snapshots.get(id);
        snapshots.delete(id);
        if (found) {
          push({ type: "snapshots_changed", nibbletId: found.snapshot.nibbletId, activity: null });
        }
        return { ok: true };
      },
    },
    connect: {
      status: async () => connect,
      start: async () => {
        connect = {
          state: "linking",
          centralUrl: CENTRAL,
          code: "HMST-R8WL",
          approveUrl: `${CENTRAL}/link?code=HMST-R8WL`,
          expiresAt: ago(-10),
        };
        // Pretend someone approves it a few seconds later.
        setTimeout(() => {
          if (connect.state !== "linking") return;
          connect = {
            state: "linked",
            centralUrl: CENTRAL,
            serverId: "srv_mock",
            account: "Astrid",
            routes: {
              lan: [],
              tailscale: null,
              tunnel: "https://hamster-wheel-example.trycloudflare.com",
            },
            managedTunnel: false,
            lastHeartbeatAt: now(),
            lastError: null,
          };
        }, 4000);
        return connect;
      },
      cancel: async () => {
        connect = { state: "unlinked", centralUrl: CENTRAL };
        return connect;
      },
      unlink: async () => {
        connect = { state: "unlinked", centralUrl: CENTRAL };
        return connect;
      },
    },
    tailscale: {
      status: async () => tailscale,
      set: async ({ serving }) => {
        tailscale = {
          ...tailscale,
          serving,
          url: serving ? "https://pogair.tail1234.ts.net" : null,
        };
        return tailscale;
      },
      login: async () => tailscale,
    },
    harnesses: {
      models: async ({ harness }) =>
        harness === "opencode"
          ? { harness, state: "ready", detail: null, models: mockOpencodeModels }
          : { harness, state: "ready", detail: null, models: [...harnesses[harness].models] },
    },
    hostTools: {
      list: async () => ({ connected: true, detail: null, servers: mockHostTools }),
    },
    updates: {
      harnesses: async () => harnessUpdates,
      check: async () =>
        (harnessUpdates = { ...harnessUpdates, checkedAt: new Date().toISOString() }),
      updateHarness: async ({ id }) => {
        for (const h of harnessUpdates.harnesses) {
          if ((id && h.id !== id) || !h.latest || h.latest === (h.installed ?? h.bundled)) continue;
          const latest = h.latest;
          setHarness(h.id, { updating: true });
          setTimeout(() => setHarness(h.id, { updating: false, installed: latest }), 2500);
        }
        return harnessUpdates;
      },
      useBundled: async ({ id }) => {
        setHarness(id, { installed: null });
        return harnessUpdates;
      },
      setAuto: async ({ auto }) => (harnessUpdates = { ...harnessUpdates, auto }),
      app: async () => appUpdate,
      applyApp: async () => (appUpdate = { ...appUpdate, updating: true }),
    },

    clis: {
      list: async () => ({
        connected: true,
        detail: null,
        clis: [
          {
            id: "gh",
            label: "GitHub CLI",
            installed: true,
            signedIn: true,
            account: "astrid",
            detail: "github.com",
          },
        ],
      }),
    },
    onePassword: {
      status: async () => ({
        state: "connected",
        account: "astrid@infrawrench.com on my.1password.com",
        vaults: [
          { id: "v-private", name: "Private", shareable: false },
          { id: "v-nibblets", name: "Nibblets", shareable: true },
          { id: "v-banking", name: "Banking", shareable: true },
          { id: "v-work", name: "Work", shareable: true },
        ],
        detail: null,
      }),
      grants: async () => ({ ...onePasswordGrants }),
      setGrants: async ({ nibbletId, grants }) => {
        if (grants.length > 0) onePasswordGrants[nibbletId] = grants;
        else delete onePasswordGrants[nibbletId];
        return { ...onePasswordGrants };
      },
    },
    auth: {
      createPairingLink: async () => ({
        url: `${window.location.origin}/#pair=mock-${crypto.randomUUID().slice(0, 6)}`,
        expiresAt: ago(-10),
      }),
    },
  };

  const dispatch = createDispatcher(contract, handlers);
  const live: LiveFeed = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onState(l: (s: LiveState) => void) {
      l("open");
      return () => {};
    },
    onReconnect: () => () => {},
    close() {},
  };
  return createMockConnection((path, input) => dispatch(path, input, null), live);
}
