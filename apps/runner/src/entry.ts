/**
 * A nibblet's machine's first process, run as root (SYSTEM on Windows)
 * just long enough to set things up and split the machine into two users:
 *
 * - the guard, which holds the secrets: the browser and its tokens, the
 *   gate with its "ask me first" rules, and the MCP servers behind it
 *   (1Password among them) with their settings;
 * - the runner and the agent, which only know the gate's address.
 *
 * Neither keeps any privilege. Before they start, a firewall stops the
 * agent reaching the cloud metadata address, or anything on its machine's
 * network but the server and the credential proxy: not other nibblets.
 *
 * Where it starts them, and how, is the OS's (entry/linux.ts, macos.ts,
 * windows.ts): a container's is Linux, a VM's whatever it runs. Linux's
 * also starts Tailscale, for a nibblet on the user's tailnet.
 *
 * `entry.ts subagent`, run by the server in its parent's machine, starts a
 * sub-agent's own guard and runner beside the parent's: the same files,
 * tools and servers, but its own browser (with its own profile), gate,
 * harness state and temporary folder. It shares the parent's desktop (see
 * desktop.ts), as it does its files. The other commands are what the
 * server would otherwise do to a container from outside (see EntryCommand).
 */
// First, so tls distrusts the compromised eMudhra intermediates before anything connects.
import "kill-emudhra";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { GUARD_ONLY_ENV, WindowsProductKey } from "@nibblet/protocol";
import { platformHere } from "./entry/index.ts";
import { pick } from "./entry/shared.ts";

export {
  firewallRules,
  nameservers,
  ownSubnet,
  tailnetPorts,
  tailnetRules,
} from "./entry/linux.ts";

const platform = platformHere();
const HOME = platform.home;
const GUARD_HOME = path.join(HOME, ".guard");
const DOWNLOADS = path.join(HOME, "Downloads");
/** Sub-agents' harness state, and their guards' homes (browser profiles), by id. */
export const SUBAGENT_STATE = path.join(HOME, ".subagents");
const SUBAGENT_GUARD_HOMES = path.join(GUARD_HOME, "subagents");
/** Each running sub-agent's entry's pid, so the server can stop it. */
export const SUBAGENT_PIDS = platform.pids;

const log = (message: string) => console.log(`entry: ${message}`);

interface Pair {
  /** The guard's home: its browser profile and settings. */
  guardHome: string;
  /** Extra environment for both. */
  env: Record<string, string>;
  /** Extra environment for the guard alone. */
  guardEnv: Record<string, string>;
  /** Extra environment for the runner alone. */
  runnerEnv: Record<string, string>;
  /** The guard's runtime folder: a sub-agent's browser has its own display. */
  runtimeDir: string | null;
}

/** Starts the guard and the runner, and stops both, then this process, when either stops. */
async function startPair(pair: Pair, onStop: () => Promise<void> = async () => {}): Promise<void> {
  const guard = platform.spawn(
    "guard",
    "guard.ts",
    {
      ...pick([
        ...platform.guardEnv,
        "NIBBLET_ID",
        "NIBBLET_SERVER_URL",
        "NIBBLET_BROWSER",
        ...GUARD_ONLY_ENV,
      ]),
      ...pair.env,
      ...pair.guardEnv,
      HOME: pair.guardHome,
      USER: "guard",
      ...(pair.runtimeDir ? { XDG_RUNTIME_DIR: pair.runtimeDir } : {}),
    },
    { group: true },
  );

  // Everything but the guard's secrets.
  const runnerEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !GUARD_ONLY_ENV.includes(k)) runnerEnv[k] = v;
  }
  const runner = platform.spawn(
    "agent",
    "main.ts",
    {
      ...runnerEnv,
      ...pair.env,
      ...pair.runnerEnv,
      HOME,
      USER: "nibblet",
      ...(process.platform === "win32" ? { USERPROFILE: HOME } : {}),
    },
    { group: false },
  );

  // One stops, both stop: the server sees the machine's entry end and says so.
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    // Also once both have exited and nothing's left to wait for, before the timeout.
    process.exitCode = code;
    for (const child of [guard, runner]) if (child.exitCode === null) child.kill("SIGTERM");
    // Long enough for the runner to give background tasks their SHUTDOWN_GRACE_MS.
    setTimeout(() => void onStop().finally(() => process.exit(code)), 10_000).unref();
  };
  let exited = 0;
  const exit = (name: string) => (code: number | null) => {
    log(`the ${name} stopped (${code})`);
    stop(code ?? 1);
    if (++exited === 2) void onStop();
  };
  guard.on("exit", (code) => {
    // Its browser and MCP servers, which it may not have had the chance to
    // stop: a sub-agent's would outlive it, in a machine that carries on.
    platform.killTree(guard);
    exit("guard")(code);
  });
  runner.on("exit", exit("runner"));
  process.on("SIGTERM", () => stop(0));
  process.on("SIGINT", () => stop(0));
}

async function main(): Promise<void> {
  const cleanUp = await platform.prepare(log);
  await startPair(
    {
      guardHome: GUARD_HOME,
      env: {},
      guardEnv: {},
      runnerEnv: {},
      runtimeDir: platform.runtimeDir(null),
    },
    cleanUp,
  );
}

/**
 * Where a sub-agent's ports come from: below Linux's ephemeral range
 * (32768 up), so an outgoing connection can't take one between it being
 * picked here and its server binding it moments later.
 */
export const SUBAGENT_PORTS = { from: 20_000, to: 32_000 };

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** A port in SUBAGENT_PORTS nothing in the machine is listening on, nor in `taken`. */
async function freePort(host: string, taken: readonly number[]): Promise<number> {
  const { from, to } = SUBAGENT_PORTS;
  for (let attempt = 0; attempt < 200; attempt++) {
    // At random, so sub-agents starting together don't try the same ones.
    const port = from + Math.floor(Math.random() * (to - from));
    if (!taken.includes(port) && (await canListen(port, host))) return port;
  }
  throw new Error("no free port for the sub-agent");
}

/** Ids are the server's own (`nb_` and base64url), but they end up in paths. */
export function safeId(id: string | undefined): string {
  if (!id || !/^[\w-]+$/.test(id)) throw new Error(`not a nibblet id: ${id}`);
  return id;
}

const pidFile = (id: string) => path.join(SUBAGENT_PIDS, `${id}.pid`);

/** A sub-agent's guard and runner, in its parent's machine (already set up by its entry). */
async function subagent(): Promise<void> {
  const id = safeId(process.env.NIBBLET_ID);
  const file = pidFile(id);
  // A run of this one that's still going (its server lost track of it) gives way.
  const previous = Number(await readFile(file, "utf8").catch(() => ""));
  if (previous > 0 && previous !== process.pid) await platform.terminate(previous, 15_000);
  await mkdir(SUBAGENT_PIDS, { recursive: true, mode: 0o700 });
  await writeFile(file, String(process.pid));

  await platform.ownedDir(SUBAGENT_STATE, "agent", 0o700);
  const state = path.join(SUBAGENT_STATE, id);
  await platform.ownedDir(state, "agent", 0o700);
  await platform.ownedDir(SUBAGENT_GUARD_HOMES, "guard", 0o700);
  const guardHome = path.join(SUBAGENT_GUARD_HOMES, id);
  await platform.ownedDir(guardHome, "guard", 0o700);
  await platform.link(DOWNLOADS, path.join(guardHome, "Downloads"));
  // Its own temporary folder: where harnesses put logins, and the runner its task logs.
  const tmp = platform.tmpDir(id);
  await platform.ownedDir(tmp, "agent", 0o700);

  const gate = await freePort("127.0.0.1", []);
  const browser = await freePort("0.0.0.0", [gate]);
  const ports = { gate, browser, view: await freePort("0.0.0.0", [gate, browser]) };
  log(`sub-agent ${id}: gate on ${ports.gate}, browser view on ${ports.view}`);
  await startPair(
    {
      guardHome,
      env: { NIBBLET_GATE_PORT: String(ports.gate), NIBBLET_VIEW_PORT: String(ports.view) },
      guardEnv: { NIBBLET_BROWSER_PORT: String(ports.browser) },
      runnerEnv: {
        NIBBLET_STATE_DIR: state,
        TMPDIR: tmp,
        ...(process.platform === "win32" ? { TEMP: tmp, TMP: tmp } : {}),
      },
      runtimeDir: platform.runtimeDir(id),
    },
    async () => {
      // Only its own: a newer run may have taken the file over.
      if ((await readFile(file, "utf8").catch(() => "")) === String(process.pid))
        await rm(file, { force: true });
    },
  );
}

/** `entry.ts stop-subagent <id>`: asks its entry to stop, then makes it once its tasks have had their time. */
async function stopSubagent(): Promise<void> {
  const pid = Number(await readFile(pidFile(safeId(process.argv[3])), "utf8").catch(() => ""));
  if (pid > 0) await platform.terminate(pid, 12_000);
}

/** `entry.ts remove-subagent <id>`: what a sub-agent kept in its host's home. */
async function removeSubagent(): Promise<void> {
  const id = safeId(process.argv[3]);
  await rm(path.join(SUBAGENT_STATE, id), { recursive: true, force: true });
  await rm(path.join(SUBAGENT_GUARD_HOMES, id), { recursive: true, force: true });
}

/** `entry.ts tailscale-leave`: just signs out the machine a nibblet left, where there's Tailscale. */
async function leaveTailnet(): Promise<void> {
  await platform.leaveTailnet?.();
}

/** `entry.ts product-key`: Windows' activation, with the key on stdin, never in its arguments. */
async function productKey(): Promise<void> {
  if (!platform.activateWindows) throw new Error("this machine doesn't run Windows");
  let key = "";
  for await (const chunk of process.stdin) key += String(chunk);
  console.log(await platform.activateWindows(WindowsProductKey.parse(key)));
}

/** What the server runs in a nibblet's machine; see EntryCommand in protocol. */
const commands: Record<string, () => Promise<void>> = {
  subagent,
  "tailscale-leave": leaveTailnet,
  "stop-subagent": stopSubagent,
  "remove-subagent": removeSubagent,
  "archive-home": () => platform.archiveHome(),
  "restore-home": () => platform.restoreHome(),
  "product-key": productKey,
};

if (import.meta.main) {
  (commands[process.argv[2] ?? ""] ?? main)().catch((err: unknown) => {
    console.error(`entry: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
