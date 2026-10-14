import {
  RpcError,
  contract,
  createDispatcher,
  defaultHamsterLook,
  harnesses,
  opencodeModel,
  maskMcpServers,
  mergeMcpServers,
  randomHamsterLook,
  type Contract,
  type HostTool,
  type McpServerDef,
  type Handlers,
  type LiveMessage,
  type Memory,
  type Nibblet,
  type ConnectStatus,
  type Schedule,
  type StoredItem,
  type ThreadItem,
  type TailscaleStatus,
} from "@nibblet/protocol";
import {
  createMockConnection,
  type LiveFeed,
  type LiveState,
  type ServerConnection,
} from "./connection.ts";

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
        instructions:
          "Look after my inbox and calendar. Summarise anything important each morning.",
        look: { ...defaultHamsterLook, accessory: "headphones", accessoryColour: "teal" },
      }),
      nibblet({
        id: "pip-research",
        name: "Flight research",
        parentId: "pip",
        status: "working",
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
        status: "idle",
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
  const reply = (id: string, text: string) => {
    const turnId = crypto.randomUUID();
    const started = now();
    store(id, {
      type: "user_message",
      id: crypto.randomUUID(),
      turnId,
      createdAt: started,
      text,
      source: "user",
    });
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
            heartbeats: [],
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
      send: async ({ id, text }) => {
        reply(id, text);
        return { ok: true };
      },
      interrupt: async ({ id }) => {
        save({ ...get(id), status: "idle" });
        return { ok: true };
      },
      wake: async () => ({ ok: true }),
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
