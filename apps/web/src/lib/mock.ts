import {
  RpcError,
  contract,
  createDispatcher,
  defaultHamsterLook,
  defaultSnapshotPolicy,
  harnesses,
  opencodeModel,
  MASKED,
  maskMcpServers,
  maskProductKey,
  mergeMcpServers,
  tailnetHostname,
  randomHamsterLook,
  type BankField,
  type BankKind,
  type BankProvider,
  type PublicAddress,
  type BankSettings,
  type Card,
  type Contract,
  type OnePasswordGrants,
  type HostTool,
  type McpServerDef,
  type Handlers,
  type LiveMessage,
  type Memory,
  type Nibblet,
  type NibbletLocation,
  type ConnectStatus,
  type DesktopApp,
  type Schedule,
  type Snapshot,
  type SnapshotActivity,
  type StoredItem,
  type ThreadItem,
  type TailscaleStatus,
  type TailnetOAuth,
  type AppUpdate,
  type HarnessUpdates,
  budgetMonth,
  budgetResetsAt,
  type GuestImage,
  type MachineBackend,
  type MachineCapabilities,
  DEFAULT_MACHINE,
} from "@nibblets/protocol";
import {
  createMockConnection,
  type LiveFeed,
  type LiveState,
  type ServerConnection,
} from "./connection.ts";
import type { FileRef } from "@nibblets/protocol";
import { mockFileRef, registerMockFile } from "./files.ts";

/** Where Pip's person shared from, and where every mock lookup lands. */
const LONDON = {
  latitude: 51.5246,
  longitude: -0.0781,
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
} satisfies Omit<NibbletLocation, "sharedAt">;

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

/** The apps the runner image ships, as its launcher lists them (without their icons). */
const mockApps: DesktopApp[] = [
  {
    id: "foot",
    name: "Foot",
    comment: "A wayland native terminal emulator",
    icon: null,
    command: "foot",
    args: [],
    categories: ["System", "TerminalEmulator"],
  },
  {
    id: "org.xfce.mousepad",
    name: "Mousepad",
    comment: "Simple Text Editor",
    icon: null,
    command: "mousepad",
    args: [],
    categories: ["Utility", "TextEditor", "GTK"],
  },
];

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
    promptName: null,
    plain: false,
    parentId: null,
    status: "idle",
    statusDetail: null,
    resources: { cpus: null, memoryMb: null },
    monthlyBudgetUsd: null,
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
    machine: DEFAULT_MACHINE,
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
        location: { ...LONDON, sharedAt: ago(60 * 26) },
        spendingLimits: [
          { asset: "USD", amount: "15000", period: "month" },
          { asset: "BTC", amount: "200000", period: "total" },
        ],
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

  const usd = { code: "USD", decimals: 2 };
  const btc = { code: "BTC", decimals: 8 };

  // The banks, with the forms their plugins describe on a real server
  // (`packages/bank-*`). Slash and Bitcoin start set up.
  const field = (key: string, label: string, more: Partial<BankField> = {}): BankField => ({
    key,
    label,
    hint: null,
    placeholder: null,
    required: false,
    secret: false,
    options: null,
    generate: null,
    lockedByCards: false,
    ...more,
  });
  const treasuryHint =
    "The private key of the wallet cards are funded from. Make a new one and keep a copy somewhere safe: it's the only way to the treasury's coins.";
  const bankKinds: BankKind[] = [
    {
      id: "slash",
      name: "Slash",
      about: "Virtual cards in US dollars, on your Slash business account.",
      instrument: "card",
      purchaseHook: null,
      fields: [
        field("SLASH_API_KEY", "API key", {
          required: true,
          secret: true,
          hint: "Make one in Slash's dashboard, with the cards.view and cards.manage permissions.",
        }),
        field("SLASH_ACCOUNT_ID", "Account ID", {
          hint: "The account cards are made under, and whose balance shows here. Slash picks your first commercial account if it's blank.",
        }),
        field("SLASH_BASE_URL", "API URL", {
          placeholder: "https://api.joinslash.com",
          hint: "Only to point at another Slash API, such as a sandbox.",
        }),
      ],
    },
    {
      id: "stripe",
      name: "Stripe",
      about: "Virtual cards from Stripe Issuing, on your Stripe account.",
      instrument: "card",
      purchaseHook: {
        url: null,
        changes: false,
        where:
          "In Stripe's Issuing settings (dashboard.stripe.com/account/issuing), make this the real-time authorizations webhook, and have Stripe decline when it doesn't answer, so nothing goes through while this server can't be reached. Stripe then asks about every card on the account; this server only judges nibblets' cards. Paste the webhook's signing secret into the form, and into any other Stripe bank on the same account.",
      },
      fields: [
        field("STRIPE_API_KEY", "API key", {
          required: true,
          secret: true,
          placeholder: "sk_live_… or rk_live_…",
          hint: "A secret key, or a restricted key with write access to Issuing cards and read access to Issuing cardholders, authorizations and transactions, and balances.",
        }),
        field("STRIPE_CARDHOLDER_ID", "Cardholder ID", {
          required: true,
          placeholder: "ich_…",
          hint: "The Issuing cardholder cards are made for. Make one in Stripe's dashboard; its billing address goes with each card.",
        }),
        field("STRIPE_CURRENCY", "Currency", {
          lockedByCards: true,
          options: [
            { value: "usd", label: "US dollars" },
            { value: "eur", label: "Euros" },
            { value: "gbp", label: "Pounds sterling" },
          ],
          hint: "Your Issuing balance's currency. US dollars if it's blank.",
        }),
        field("STRIPE_WEBHOOK_SECRET", "Webhook signing secret", {
          secret: true,
          placeholder: "whsec_…",
          hint: "The real-time authorizations webhook's, from Stripe's Issuing settings. With it, this server approves each purchase on a nibblet's card, and only if the card is open and has room for it. Purchases on the account's other cards go through as they would without it.",
        }),
      ],
    },
    {
      id: "bitcoin",
      name: "Bitcoin",
      about: "A treasury wallet that funds a fresh wallet for each card, with exactly its limit.",
      instrument: "wallet",
      purchaseHook: null,
      fields: [
        field("BITCOIN_NETWORK", "Network", {
          required: true,
          lockedByCards: true,
          options: [
            { value: "mainnet", label: "Mainnet" },
            { value: "testnet", label: "Testnet4" },
            { value: "signet", label: "Signet" },
            { value: "regtest", label: "Regtest" },
          ],
          hint: "Try it on signet first: its coins are free.",
        }),
        field("BITCOIN_TREASURY_KEY", "Treasury key", {
          required: true,
          secret: true,
          generate: "private_key",
          lockedByCards: true,
          placeholder: "Hex or WIF",
          hint: treasuryHint,
        }),
        field("BITCOIN_ESPLORA_URL", "Esplora API", {
          placeholder: "mempool.space's",
          hint: "Where the chain is read and transactions are sent. Needed for regtest.",
        }),
        field("BITCOIN_FEE_RATE", "Fee rate", {
          placeholder: "Esplora's estimate",
          hint: "In sat/vB.",
        }),
      ],
    },
    {
      id: "ethereum",
      name: "Ethereum",
      about:
        "A treasury account on Ethereum or another EVM chain, funding a fresh account for each card.",
      instrument: "wallet",
      purchaseHook: null,
      fields: [
        field("ETHEREUM_TREASURY_KEY", "Treasury key", {
          required: true,
          secret: true,
          generate: "private_key",
          lockedByCards: true,
          placeholder: "0x…",
          hint: treasuryHint.replace("wallet", "account"),
        }),
        field("ETHEREUM_RPC_URL", "RPC URL", {
          required: true,
          secret: true,
          placeholder: "https://…",
          hint: "A JSON-RPC endpoint for the chain. Kept secret, since many carry an API key.",
        }),
        field("ETHEREUM_CHAIN_ID", "Chain ID", {
          lockedByCards: true,
          placeholder: "Any",
          hint: "Checked against the RPC before anything is sent: 1 for mainnet, 11155111 for Sepolia.",
        }),
        field("ETHEREUM_ASSET", "Coin", {
          lockedByCards: true,
          placeholder: "ETH",
          hint: "The chain's own coin, for another EVM chain: POL for Polygon, say.",
        }),
      ],
    },
  ];
  const mockBanks: { id: string; kind: string; name: string; settings: BankSettings }[] = [
    {
      id: "slash",
      kind: "slash",
      name: "",
      settings: { SLASH_API_KEY: "mock-slash-key", SLASH_ACCOUNT_ID: "acc_8f3k2m" },
    },
    {
      id: "bitcoin",
      kind: "bitcoin",
      name: "",
      settings: { BITCOIN_NETWORK: "signet", BITCOIN_TREASURY_KEY: "mock-treasury-key" },
    },
  ];
  /** What's in each to start with; a Slash account set up later has a little, a new treasury nothing. */
  const bankBalances = new Map([
    ["slash", "248650"],
    ["bitcoin", "4180000"],
  ]);
  const bankProvider = (bank: (typeof mockBanks)[number]): BankProvider => {
    const { id, settings } = bank;
    const named = (label: string) => (bank.name ? `${bank.name} · ${label}` : label);
    const base = { id, state: "ready" as const, detail: null, approvesPurchases: false };
    if (bank.kind === "stripe") {
      const currency = settings.STRIPE_CURRENCY ?? "usd";
      return {
        ...base,
        label: named(settings.STRIPE_API_KEY?.includes("_test_") ? "Stripe (test mode)" : "Stripe"),
        asset: { code: currency.toUpperCase(), decimals: 2 },
        instrument: "card",
        balance: bankBalances.get(id) ?? "50000",
        fundAt: null,
        approvesPurchases: Boolean(settings.STRIPE_WEBHOOK_SECRET),
      };
    }
    if (bank.kind === "slash") {
      return {
        ...base,
        label: named("Slash"),
        asset: usd,
        instrument: "card",
        balance: settings.SLASH_ACCOUNT_ID ? (bankBalances.get(id) ?? "125000") : null,
        fundAt: null,
      };
    }
    if (bank.kind === "bitcoin") {
      const network = settings.BITCOIN_NETWORK ?? "signet";
      return {
        ...base,
        label: named(network === "mainnet" ? "Bitcoin" : `Bitcoin (${network})`),
        asset: btc,
        instrument: "wallet",
        balance: bankBalances.get(id) ?? "0",
        fundAt:
          id === "bitcoin"
            ? "tb1q7cyrfmck2ffu2ud3rn5l5a8yv6f0chkp9ydvzd"
            : network === "mainnet"
              ? "bc1qg5ng2mns0ugrwa4yhqekz7nlvtcfa2fjvp4w8a"
              : "tb1qg5ng2mns0ugrwa4yhqekz7nlvtcfa2fjjxw5n6",
      };
    }
    const asset = settings.ETHEREUM_ASSET ?? "ETH";
    return {
      ...base,
      label: named(asset === "ETH" ? "Ethereum" : `Ethereum (${asset})`),
      asset: { code: asset, decimals: 18 },
      instrument: "wallet",
      balance: bankBalances.get(id) ?? "0",
      fundAt: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    };
  };
  const liveCardsAt = (id: string) =>
    cards.filter((c) => c.provider === id && c.state !== "closed").length;
  /** The reverse proxy the person said this server is behind, if any; else the Connect tunnel's address. */
  let mockProxy: string | null = null;
  const publicAddress = (): PublicAddress =>
    mockProxy
      ? { url: mockProxy, via: "proxy", proxy: mockProxy }
      : { url: "https://studio.nibblets.dev", via: "tunnel", proxy: null };
  const bankStatus = () => ({
    providers: mockBanks.map(bankProvider),
    problems: [],
    kinds: bankKinds.map((k) =>
      k.purchaseHook
        ? {
            ...k,
            purchaseHook: {
              ...k.purchaseHook,
              url: `${publicAddress().url}/bank/${k.id}/purchases`,
            },
          }
        : k,
    ),
    banks: mockBanks.map((bank) => {
      const fields = bankKinds.find((k) => k.id === bank.kind)?.fields ?? [];
      return {
        id: bank.id,
        kind: bank.kind,
        name: bank.name,
        source: "saved" as const,
        settings: Object.fromEntries(
          Object.entries(bank.settings).map(([key, value]) => [
            key,
            fields.find((f) => f.key === key)?.secret ? MASKED : value,
          ]),
        ),
        liveCards: liveCardsAt(bank.id),
      };
    }),
  });
  const cards: Card[] = [
    {
      id: "card_flights",
      nibbletId: "pip",
      provider: "slash",
      asset: usd,
      kind: "multi_use",
      limit: "12000",
      spent: "0",
      purpose: "Flight to Lisbon, if the fare drops under £80",
      display: "•••• 4821",
      state: "open",
      closedBy: null,
      createdAt: ago(40),
      closedAt: null,
    },
    {
      id: "card_domain",
      nibbletId: "pip",
      provider: "slash",
      asset: usd,
      kind: "single_use",
      limit: "1500",
      spent: "1288",
      purpose: "Renew nibblets.dev at the registrar",
      display: "•••• 0193",
      state: "closed",
      closedBy: "provider",
      createdAt: ago(60 * 26),
      closedAt: ago(60 * 26 - 4),
    },
    {
      id: "card_relay",
      nibbletId: "pip",
      provider: "bitcoin",
      asset: btc,
      kind: "single_use",
      limit: "50000",
      spent: "0",
      purpose: "Pay for a month of the VPN relay",
      display: "tb1q9h7garjr0e3y0ls6dx5l2s5k6l3e0zq0d6v5wl",
      state: "open",
      closedBy: null,
      createdAt: ago(12),
      closedAt: null,
    },
    {
      id: "card_tip",
      nibbletId: "pip",
      provider: "bitcoin",
      asset: btc,
      kind: "multi_use",
      limit: "20000",
      spent: "0",
      purpose: "Tip the podcast for the Lisbon recommendations",
      display: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      state: "closing",
      closedBy: "nibblet",
      createdAt: ago(9),
      closedAt: null,
    },
  ];

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
    {
      type: "approval",
      id: "v1",
      turnId: "turn-3",
      createdAt: ago(1),
      server: "nibblet",
      tool: "card_verify",
      input: {
        card: "card_flights",
        display: "•••• 4821",
        merchant: "British Airways",
        asks: "A code texted to the phone ending 12",
      },
      status: "pending",
      reason: null,
      decidedAt: null,
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
  let tailnetOAuth: TailnetOAuth | null = null;
  let tailscale: TailscaleStatus = {
    installed: true,
    running: true,
    stopped: false,
    serving: false,
    url: null,
    detail: null,
    action: null,
  };
  let serverName = "Astrid's Mac mini";
  let systemPromptExtra = "";
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
    progress: null,
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
    // Ask about the weather, or where something is, and it asks where you are.
    if (/\b(where|weather|nearby)\b/i.test(text)) {
      store(id, {
        type: "location_request",
        id: crypto.randomUUID(),
        turnId,
        createdAt: now(),
        status: "pending",
        place: null,
        decidedAt: null,
      });
    }
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
  const guestVm: MachineCapabilities = {
    browser: true,
    tailscale: true,
    sshAgent: false,
    liveResources: false,
    localSignIn: false,
  };
  const ready: GuestImage = { state: "ready", detail: null, progress: null, source: "none" };
  const mockMachines: MachineBackend[] = [
    {
      id: "docker",
      name: "Docker",
      kind: "container",
      available: true,
      detail: null,
      recommended: true,
      guests: [
        {
          os: "linux",
          image: ready,
          capabilities: { ...guestVm, sshAgent: true, liveResources: true, localSignIn: true },
        },
      ],
    },
    {
      id: "apple",
      name: "Apple Virtualization",
      kind: "vm",
      available: true,
      detail: null,
      recommended: false,
      guests: [{ os: "linux", image: { ...ready, state: "missing" }, capabilities: guestVm }],
    },
    {
      id: "hyperv",
      name: "Hyper-V",
      kind: "vm",
      available: true,
      detail: null,
      recommended: false,
      guests: [
        { os: "windows", image: { ...ready, source: "windows-iso" }, capabilities: guestVm },
      ],
    },
  ];

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
          {
            provider: "deepseek",
            source: "env",
            ok: true,
            detail: "API key set",
            plan: null,
            expiresAt: null,
          },
        ],
        host: { cpus: 10, memoryMb: 16384 },
      }),
      rename: async ({ name }) => {
        serverName = name;
        return { ok: true };
      },
      systemPrompt: async () => ({ text: systemPromptExtra }),
      setSystemPrompt: async ({ text }) => {
        systemPromptExtra = text;
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
            promptName: input.promptName ?? null,
            plain: input.plain ?? false,
            machine: input.machine,
            windowsProductKey: input.windowsProductKey
              ? maskProductKey(input.windowsProductKey)
              : null,
            browser: input.browser,
            hostTools: input.hostTools,
            cliCredentials: input.cliCredentials,
            mcpServers: keepSecrets(id, input.mcpServers),
            toolApprovals: input.toolApprovals,
            heartbeats: [],
            resources: { cpus: null, memoryMb: null },
            monthlyBudgetUsd: null,
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
          promptName: patch.promptName !== undefined ? patch.promptName : current.promptName,
          plain: patch.plain ?? current.plain,
          browser: patch.browser ?? current.browser,
          hostTools: patch.hostTools ?? current.hostTools,
          cliCredentials: patch.cliCredentials ?? current.cliCredentials,
          mcpServers: patch.mcpServers
            ? keepSecrets(id, mergeMcpServers(patch.mcpServers, secrets.get(id) ?? []))
            : current.mcpServers,
          toolApprovals: patch.toolApprovals ?? current.toolApprovals,
          ...(patch.tailscale !== undefined
            ? {
                tailscale: patch.tailscale && {
                  ...patch.tailscale,
                  authKey: patch.tailscale.authKey ? MASKED : "",
                },
                tailnetNode: patch.tailscale && {
                  state: "running" as const,
                  dnsName: `${patch.tailscale.hostname || tailnetHostname(current.name)}.tail1234.ts.net`,
                  ips: ["100.101.102.103"],
                  tailnet: "example.com",
                  detail: null,
                },
              }
            : {}),
          resources: patch.resources ?? current.resources,
          monthlyBudgetUsd:
            patch.monthlyBudgetUsd !== undefined
              ? patch.monthlyBudgetUsd
              : current.monthlyBudgetUsd,
          snapshotPolicy: patch.snapshotPolicy ?? current.snapshotPolicy,
          spendingLimits: patch.spendingLimits ?? current.spendingLimits,
          // No geocoder here: wherever it is, it's London.
          location:
            patch.location !== undefined
              ? patch.location && { ...patch.location, place: LONDON.place, sharedAt: now() }
              : current.location,
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
      logs: async ({ id }) => ({ text: `entry: ${get(id).name}'s machine, in the mock\n` }),
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
      // The mock has no API keys, so nothing is ever spent.
      spend: async ({ id }) => {
        const now = new Date();
        const budgetUsd = get(id).monthlyBudgetUsd;
        return {
          nibbletId: id,
          budgetUsd,
          spentUsd: 0,
          month: budgetMonth(now),
          resetsAt: budgetResetsAt(now).toISOString(),
          allowed: true,
        };
      },
      tasks: async () => [],
      apps: async () => mockApps,
      stopTask: async () => ({ ok: true }),
      answerLocation: async ({ id, requestId, location }) => {
        const found = items.get(id)?.find((s) => s.item.id === requestId)?.item;
        if (found?.type !== "location_request" || found.status !== "pending")
          throw new RpcError("not_found", "It isn't waiting to hear where you are any more");
        store(id, {
          ...found,
          status: location ? "shared" : "declined",
          place: location ? "Shoreditch, London, England, United Kingdom" : null,
          decidedAt: now(),
        });
        // No geocoder here: wherever it is, it's London.
        if (location)
          save({ ...get(id), location: { ...location, place: LONDON.place, sharedAt: now() } });
        return { ok: true };
      },
      browserBorrowStart: async ({ id }) => ({
        nibbletId: id,
        state: "local" as const,
        detail: null,
        proxyPort: 54321,
        onePassword: true,
        startedAt: Date.now(),
      }),
      browserBorrowEnd: async ({ id }) => ({
        nibbletId: id,
        state: "handback" as const,
        detail: null,
        proxyPort: null,
        onePassword: true,
        startedAt: Date.now(),
      }),
      browserBorrow: async () => null,
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
    bank: {
      status: async () => bankStatus(),
      cards: async ({ nibbletId }) => cards.filter((c) => c.nibbletId === nibbletId),
      allowances: async ({ nibbletId }) => {
        const n = nibblets.get(nibbletId);
        return (n?.spendingLimits ?? []).map((limit) => {
          const used = cards
            .filter((c) => c.nibbletId === nibbletId && c.asset.code === limit.asset)
            .reduce((sum, c) => sum + BigInt(c.state === "closed" ? c.spent : c.limit), 0n);
          const cap = BigInt(limit.amount);
          return {
            limit,
            used: used.toString(),
            remaining: (used >= cap ? 0n : cap - used).toString(),
            since: ago(60 * 24 * 18),
          };
        });
      },
      kill: async ({ id }) => {
        const i = cards.findIndex((c) => c.id === id);
        const card = cards[i];
        if (!card) throw new RpcError("not_found", `No card ${id}`);
        const killed: Card = { ...card, state: "closed", closedBy: "user", closedAt: now() };
        cards[i] = killed;
        push({ type: "cards_changed", nibbletId: card.nibbletId });
        return killed;
      },
      // Checked as a real server would, with the provider faked: Slash
      // refuses the key `wrong`.
      configure: async ({ id, kind: kindId, name: rawName, settings: input }) => {
        const kind = bankKinds.find((k) => k.id === kindId);
        if (!kind) throw new RpcError("not_found", `No bank plugin called ${kindId}`);
        const existing = id === null ? null : mockBanks.find((b) => b.id === id);
        if (existing === undefined) throw new RpcError("not_found", `No bank called ${id}`);
        const name = rawName.trim();
        const title = name ? `${name} (${kind.name})` : kind.name;
        const others = mockBanks.filter((b) => b.kind === kind.id && b.id !== existing?.id);
        if (!name && others.some((b) => !b.name)) {
          throw new RpcError(
            "bad_request",
            `Give it a name, to tell it from your other ${kind.name} bank${others.length === 1 ? "" : "s"}`,
          );
        }
        if (name && others.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
          throw new RpcError("conflict", `There's already a ${kind.name} bank called ${name}`);
        }
        const current = existing?.settings ?? {};
        const next: BankSettings = {};
        for (const f of kind.fields) {
          const sent = input[f.key]?.trim() ?? "";
          const value = f.secret && sent === MASKED ? (current[f.key] ?? "") : sent;
          if (value) next[f.key] = value;
        }
        const missing = kind.fields.find((f) => f.required && !next[f.key]);
        if (missing) throw new RpcError("bad_request", `${missing.label} is needed`);
        const locked = kind.fields.filter(
          (f) => f.lockedByCards && (current[f.key] ?? "") !== (next[f.key] ?? ""),
        );
        if (existing && locked.length > 0 && liveCardsAt(existing.id) > 0) {
          throw new RpcError(
            "conflict",
            `${locked.map((f) => f.label).join(" and ")} can't change while ${title} has cards that aren't closed: kill them first.`,
          );
        }
        await pause(900);
        if (next.SLASH_API_KEY === "wrong") {
          throw new RpcError("bad_request", "Slash: Invalid API key");
        }
        const key = next.BITCOIN_TREASURY_KEY ?? next.ETHEREUM_TREASURY_KEY;
        const changedKey =
          key !== undefined &&
          key !== (current.BITCOIN_TREASURY_KEY ?? current.ETHEREUM_TREASURY_KEY);
        if (changedKey && !/^(0x)?[0-9a-f]{64}$/i.test(key)) {
          throw new RpcError("bad_request", "Treasury key isn't a hex private key");
        }
        if (existing) {
          if (changedKey) bankBalances.delete(existing.id);
          existing.name = name;
          existing.settings = next;
        } else {
          // As the server does: the plugin's own id first, then one from the name.
          const taken = new Set(mockBanks.map((b) => b.id));
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
          const stem = slug ? `${kind.id}-${slug}` : kind.id;
          let newId = taken.has(kind.id) ? stem : kind.id;
          for (let n = 2; taken.has(newId); n++) newId = `${stem}-${n}`;
          mockBanks.push({ id: newId, kind: kind.id, name, settings: next });
        }
        push({ type: "bank_changed" });
        return bankStatus();
      },
      remove: async ({ id }) => {
        const at = mockBanks.findIndex((b) => b.id === id);
        const bank = mockBanks[at];
        if (!bank) throw new RpcError("not_found", `No bank called ${id}`);
        const kindName = bankKinds.find((k) => k.id === bank.kind)?.name ?? bank.kind;
        const live = liveCardsAt(id);
        if (live > 0) {
          throw new RpcError(
            "conflict",
            `${bank.name ? `${bank.name} (${kindName})` : kindName} has ${live === 1 ? "a card that isn't closed" : `${live} cards that aren't closed`}, and closing them needs it: kill them first.`,
          );
        }
        mockBanks.splice(at, 1);
        push({ type: "bank_changed" });
        return bankStatus();
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
    publicAddress: {
      status: async () => publicAddress(),
      setProxy: async ({ url }) => {
        await pause(300);
        mockProxy = url;
        return publicAddress();
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
      keys: async () => ({ oauth: tailnetOAuth && { ...tailnetOAuth, clientSecret: MASKED } }),
      setKeys: async ({ oauth }) => {
        tailnetOAuth = oauth;
        return { oauth: oauth && { ...oauth, clientSecret: MASKED } };
      },
    },
    machines: {
      list: async () => mockMachines,
      prepare: async ({ backend, guest }) => {
        const image = mockMachines
          .find((b) => b.id === backend)
          ?.guests.find((g) => g.os === guest)?.image;
        if (image)
          Object.assign(image, { state: "preparing", progress: 0.1, detail: "Downloading" });
        return { ok: true };
      },
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
      applyApp: async () => {
        // Downloads over a few seconds, then sits there as if restarting.
        const tick = setInterval(() => {
          const progress = Math.min(1, (appUpdate.progress ?? 0) + 0.08);
          appUpdate = { ...appUpdate, progress };
          if (progress >= 1) clearInterval(tick);
        }, 500);
        return (appUpdate = { ...appUpdate, updating: true, progress: 0 });
      },
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
