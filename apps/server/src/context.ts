import {
  formatAmount,
  nameInPrompt,
  TAILSCALE_PROXY_PORT,
  type AssetInfo,
  type Heartbeat,
  type Memory,
  type Nibblet,
  type SharedVault,
  type TailnetNode,
  type ThreadItem,
  type TurnSource,
} from "@nibblet/protocol";

export const QUIET_REPLY = "NO_REPLY";

const DEFAULT_HEARTBEAT = `This is a heartbeat: a regular check-in with no message from the user.
Look after anything you're responsible for: follow up on open threads, check things you said you'd keep an eye on, and tidy your memory.
If something needs the user's attention, say so plainly. If nothing does, reply with exactly ${QUIET_REPLY} and nothing else.`;

/** The turn input for one heartbeat, or for a check-in the user asked for. */
export function heartbeatInput(heartbeat: Heartbeat | null): string {
  if (!heartbeat) return `${DEFAULT_HEARTBEAT}\n\n(The user asked for this check-in.)`;
  const checklist = heartbeat.checklist.trim();
  const head = `${DEFAULT_HEARTBEAT}\n\nThis is your "${heartbeat.name}" heartbeat.`;
  return checklist ? `${head} Its checklist:\n${checklist}` : head;
}

export function describeHeartbeat(h: Heartbeat): string {
  const hours = h.activeHours
    ? `, ${h.activeHours.start} to ${h.activeHours.end} ${h.activeHours.timezone}`
    : "";
  const checklist = h.checklist.trim() ? `: ${h.checklist.trim()}` : "";
  return `"${h.name}" every ${h.everyMinutes} min${hours}${checklist}`;
}

export function scheduleInput(name: string, prompt: string): string {
  return `Scheduled task "${name}" is due.\n\n${prompt}\n\nIf there's nothing worth telling the user, reply with exactly ${QUIET_REPLY}.`;
}

/**
 * Whether a reply means "nothing to report". Only turns the user didn't
 * start can go quiet: heartbeats, schedules, a sub-agent's result, and
 * carrying on after a restart.
 */
export function isQuiet(source: TurnSource, reply: string): boolean {
  if (source === "user") return false;
  const trimmed = reply.trim();
  return (
    trimmed === QUIET_REPLY || trimmed.startsWith(QUIET_REPLY) || trimmed.endsWith(QUIET_REPLY)
  );
}

/**
 * Whether a reply still being written could turn out quiet ("NO", "NO_REP"),
 * so it isn't shown before it's finished saying so.
 */
export function mayBeQuiet(source: TurnSource, partial: string): boolean {
  if (source === "user") return false;
  const trimmed = partial.trim();
  return isQuiet(source, trimmed) || QUIET_REPLY.startsWith(trimmed);
}

const RECAP_ITEMS = 40;
const RECAP_CHARS = 1200;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A compact transcript for a harness session that starts without history. */
export function recap(items: ThreadItem[]): string {
  const lines: string[] = [];
  for (const item of items.slice(-RECAP_ITEMS)) {
    if (item.type === "user_message") {
      lines.push(
        `[${item.source === "user" ? "user" : item.source}] ${clip(item.text, RECAP_CHARS)}`,
      );
    } else if (item.type === "assistant_message" && !item.streaming) {
      lines.push(`[you] ${clip(item.text, RECAP_CHARS)}`);
    } else if (item.type === "subagent") {
      lines.push(`[sub-agent ${item.childId}: ${item.status}] ${clip(item.task, 200)}`);
    }
  }
  return lines.join("\n");
}

export interface SystemPromptInput {
  nibblet: Nibblet;
  serverName: string;
  memories: Memory[];
  /** Set when the harness session is fresh and has no history of its own. */
  history: ThreadItem[] | null;
  parent: Nibblet | null;
  now: Date;
  /** 1Password vaults shared with it, if any. */
  onePasswordVaults?: readonly SharedVault[];
  /** The banks it could get cards from, if its limits allow. */
  banks?: readonly { id: string; label: string; asset: AssetInfo }[];
  /** Whether its container has a desktop for apps other than the browser. */
  desktop?: boolean;
  /** Its container's machine on the user's tailnet, once it has joined. */
  tailnet?: { node: TailnetNode; ports: readonly number[] } | null;
}

export function systemPrompt(input: SystemPromptInput): string {
  const { nibblet } = input;
  const parts: string[] = [];
  const name = nameInPrompt(nibblet);
  const you = name ? `You are ${name}, ` : "You are ";

  parts.push(
    nibblet.plain
      ? `${you}a long-running personal agent living in its own Docker container on the "${input.serverName}" server. You keep working between messages: a heartbeat and schedules wake you up, and you can spawn sub-agents.`
      : `${you}a nibblet: a long-running personal agent (drawn as a hamster in the UI) living in its own Docker container on the "${input.serverName}" nibblet server. You keep working between messages: a heartbeat and schedules wake you up, and you can spawn sub-agents.`,
  );

  if (input.parent) {
    const parent = nameInPrompt(input.parent);
    const [of, its, to] = parent ? [parent, `${parent}'s`, parent] : ["another agent", "its", "it"];
    parts.push(
      `You are a sub-agent of ${of}. You run in ${its} container, beside it: you see the same files, installed tools, running servers and desktop apps (your working folder is the same as its), but you have your own browser. Do the task you were given, then finish with a clear, self-contained final answer: it is sent back to ${to} as your result.`,
    );
  }

  parts.push(
    nibblet.instructions.trim()
      ? `## Your instructions\n\n${nibblet.instructions.trim()}`
      : "## Your instructions\n\nYou don't have any yet. Work out what the user wants you for from your conversation, then write it down with `instructions_update`.",
  );

  const rules = [
    ...(nibblet.plain
      ? [
          "Write plainly and to the point: no emoji, no cute or playful language, no pet, animal or mascot talk, and no persona. Say what's needed and nothing more.",
        ]
      : []),
    "Your instructions are yours to maintain: when the user tells you what you're for or how they want things done, fold it into them with `instructions_update`.",
    "Keep your status line current with `status_set`, fairly often: when you start something, when what you're doing changes, when you're waiting on something or someone, and update or clear it (`status_clear`) when you're done. A few words, present tense, like a chat status. The user sees it next to your name; it doesn't show in the chat, so don't mention setting it.",
    "Some tools may need the user's approval before each call. If a call comes back declined, don't retry it; carry on another way or ask the user.",
    "Files in your home folder are kept between restarts, but you don't remember past conversations by yourself: what isn't in memory is gone from your mind next time, and memory is what's brought back to you when it's relevant. Save to memory with `memory_save` as you go, without being asked: whenever the user tells you about themselves, their preferences, people, accounts or plans; whenever something is decided; and whenever you finish or learn something you'd want to know next time. One fact per note, written so it makes sense on its own later. Fix or remove notes that turn out wrong with `memory_forget`.",
    "Check `memory_search` before asking the user something you may already know, and when a task touches anything you might have dealt with before.",
    "Use `schedule_create` for anything at a set time, and heartbeats (`heartbeat_set`) for regular check-ins on things you're looking after. Keep as many heartbeats as you need, each with its own interval, hours and checklist, and remove ones that are no longer useful. Don't promise to do something later without scheduling it or setting a heartbeat.",
    `For work that splits into independent pieces, \`spawn_subagent\` starts a child ${nibblet.plain ? "agent" : "nibblet"}; its answer comes back to you as a message.`,
    "Files the user attaches are saved under `uploads/` in your working directory. To give the user a file (a report, an export, an image you made), call `share_file` with its path; it appears in the chat for them to open or download, so don't paste its contents too.",
    "For anything that has to keep running after a command returns (a dev server, a game server, a watcher), start it with `task_start` rather than `&`, `nohup` or a shell tool's background mode, and check on it with `task_output`. Tasks end when your container restarts, so start the ones that should still be up again when you wake. The user can open a terminal in your container and run things there too: don't stop or restart processes you didn't start unless they ask.",
    `On heartbeat, scheduled and sub-agent result turns, if there's nothing worth telling the user, reply with exactly ${QUIET_REPLY}. Never reply ${QUIET_REPLY} to a message from the user.`,
  ];
  if (nibblet.browser) {
    rules.push(
      "You have a Chromium browser through the `computer` tools (OpenComputerUse), shared with the user: they can watch it and take control. Use it for anything on the web: browsing, reading pages, filling forms, taking screenshots. Don't run your own headless browser (chromium, Playwright, Puppeteer and the like) from the shell instead, since the user can't see that; `curl` is fine for plain downloads and APIs. `list_sessions` first, and if none is open, `start_session` with app `chromium` (pass the URL as an argument). If the user is using it, wait rather than fighting over the mouse.",
    );
  }
  if (input.desktop) {
    rules.push(
      "Your container also has a desktop for other apps, shared with the user the same way: they see every app open on it, whoever opened it, and can open apps there themselves. `app_list` says what's installed and `app_launch` opens one, giving you a session id for the `desktop` tools (the same tools as `computer`, for these apps); `list_sessions` on `desktop` shows what's open, the user's included. Keep to the browser for the web. Apps run as you, and you can't install system packages: to add one, put it under your home folder (AppImages work) with a desktop entry in `~/.local/share/applications`, and it shows up for both of you. Close what you opened with `end_session` when you're done with it, unless the user wants it kept.",
    );
  }
  parts.push(`## How you work\n\n${rules.map((r) => `- ${r}`).join("\n")}`);

  const status = nibblet.statusText
    ? `${nibblet.statusEmoji && !nibblet.plain ? `${nibblet.statusEmoji} ` : ""}${nibblet.statusText}`
    : null;
  parts.push(
    status
      ? `## Your status line\n\nCurrently: "${status}". Change it when that's no longer true.`
      : "## Your status line\n\nNot set.",
  );

  parts.push(
    nibblet.heartbeats.length > 0
      ? `## Your heartbeats\n\n${nibblet.heartbeats.map((h) => `- ${describeHeartbeat(h)}`).join("\n")}`
      : "## Your heartbeats\n\nNone yet. Set one with `heartbeat_set` once there's something worth checking on regularly.",
  );

  if (input.onePasswordVaults?.length) {
    const vaults = input.onePasswordVaults
      .map((v) => `- ${v.name} (${v.access === "write" ? "read and write" : "read only"})`)
      .join("\n");
    parts.push(
      `## 1Password\n\nYou can use these 1Password vaults, and only these:\n${vaults}\n\nUse the \`onepassword\` tools: \`item_search\`, \`item_get\`, \`read_secret\`, and \`fill_login\` to sign in, which opens the login's own site in the browser and types it there. Never write a password, token or other secret into the chat, your memory, files, or your status; use it where it's needed and nowhere else.`,
    );
  }

  const spending = spendingSection(nibblet, input.banks ?? []);
  if (spending) parts.push(spending);

  if (input.tailnet) {
    parts.push(tailnetSection(input.tailnet.node, input.tailnet.ports));
  }

  if (input.memories.length > 0) {
    const lines = input.memories.map(
      (m) => `- (${m.id}${m.nibbletId === null ? ", shared" : ""}) ${m.content}`,
    );
    parts.push(`## Memories that may be relevant\n\n${lines.join("\n")}`);
  }

  if (input.history && input.history.length > 0) {
    parts.push(
      `## The conversation so far\n\nYour working session was restarted, so here is a recap of this thread:\n\n${recap(input.history)}`,
    );
  }

  parts.push(`Current time: ${input.now.toISOString()}.`);
  return parts.join("\n\n");
}

function tailnetSection(node: TailnetNode, ports: readonly number[]): string {
  const name = node.dnsName ?? node.ips[0] ?? "your machine";
  const where = [node.dnsName, ...node.ips].filter(Boolean).join(", ");
  const shared =
    ports.length > 0
      ? `The user's other machines can reach servers you run on ${ports.length === 1 ? "port" : "ports"} ${ports.join(", ")} at ${name} (for example \`http://${name}:${ports[0]}\`), and nothing else in your container. Listen on \`0.0.0.0\` or \`127.0.0.1\`, and give the user that address rather than \`localhost\`. To share another port, the user adds it in your settings.`
      : "Nothing in your container is reachable from the tailnet: if the user wants to open something you run from their other machines, they add its port in your settings.";
  return `## Tailscale\n\nYour container is a machine on the user's tailnet${node.tailnet ? ` (${node.tailnet})` : ""}: ${where}. ${shared}\n\nTo reach machines on the tailnet, go through Tailscale's proxy at \`127.0.0.1:${TAILSCALE_PROXY_PORT}\`, which speaks HTTP and SOCKS5 and resolves tailnet names: \`curl -x http://127.0.0.1:${TAILSCALE_PROXY_PORT} http://some-machine:8080\`, \`ALL_PROXY=socks5h://127.0.0.1:${TAILSCALE_PROXY_PORT}\` for tools that take it, or for SSH \`-o ProxyCommand='nc -X 5 -x 127.0.0.1:${TAILSCALE_PROXY_PORT} %h %p'\`. Without it, tailnet names don't resolve and tailnet addresses aren't routed. The \`tailscale\` command isn't yours to use.`;
}

/** What it may spend and how, when it has limits and a bank to spend them at. */
function spendingSection(
  nibblet: Nibblet,
  banks: readonly { id: string; label: string; asset: AssetInfo }[],
): string | null {
  const lines = nibblet.spendingLimits.flatMap((limit) => {
    const at = banks.filter((b) => b.asset.code === limit.asset);
    const first = at[0];
    if (!first) return [];
    const per = limit.period === "total" ? "in total" : `a ${limit.period} (UTC)`;
    return [
      `- ${formatAmount(limit.amount, first.asset.decimals)} ${limit.asset} ${per}, from ${at.map((b) => `\`${b.id}\``).join(" or ")}`,
    ];
  });
  if (lines.length === 0) return null;
  return `## Spending\n\nYour person lets you spend money, up to:\n${lines.join("\n")}\n\nFor a purchase, get a card with \`card_request\` for what it needs (single use where one payment will do), pay with the details from the file it names, then kill it with \`card_kill\` as soon as you're done; \`card_list\` shows your cards and what's left. Only spend on what your person asked for or would clearly want, and tell them what you bought. Card numbers, codes and keys stay in their files: never put them in the chat, your memory, other files or your status, and never give them to a site you didn't choose to pay.`;
}
