import { spawn as spawnPty, type IPty } from "node-pty";
import { homedir } from "node:os";
import { loginShell, toolEnv } from "./tools.ts";

export interface TerminalEvents {
  data(chunk: string): void;
  /** A web address the command printed, usually a sign-in page. */
  url(url: string): void;
  exit(code: number): void;
}

// Colours, cursor moves and OSC sequences (links, titles), so addresses can be found in the text.
// eslint-disable-next-line no-control-regex
const ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const URLS = /https?:\/\/[^\s"'<>`]+/g;

/**
 * The addresses in some terminal output, without its escape codes or
 * trailing punctuation. One running into the end of the text may not have
 * fully arrived yet, so it's left for the next look.
 */
export function findUrls(text: string): string[] {
  const plain = text.replace(ESCAPES, "");
  return [...plain.matchAll(URLS)]
    .filter((m) => m.index + m[0].length < plain.length)
    .map((m) => m[0].replace(/[.,;:)\]}>]+$/, ""));
}

/**
 * One command at a time in a real terminal, so installers and sign-ins
 * that ask questions, show spinners, or want a password just work. Runs in
 * the person's login shell, from their home directory.
 */
export class SetupTerminal {
  private pty: IPty | null = null;
  private pending = "";
  private seen = new Set<string>();
  private cols = 80;
  private rows = 14;

  get busy(): boolean {
    return this.pty !== null;
  }

  async run(command: string, events: TerminalEvents): Promise<void> {
    if (this.pty) throw new Error("Something is already running");
    const env = await toolEnv();
    this.seen.clear();
    this.pending = "";
    events.data(`\x1b[2m$ ${command}\x1b[0m\r\n`);
    const pty = spawnPty(loginShell(), ["-l", "-c", command], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: homedir(),
      env: { ...process.env, PATH: env.path, TERM: "xterm-256color" },
    });
    this.pty = pty;
    pty.onData((chunk) => {
      events.data(chunk);
      // Addresses can arrive split across chunks (sign-in ones run long); keep a tail to look at again.
      const text = this.pending + chunk;
      this.pending = text.slice(-4096);
      this.announce(text, events);
    });
    pty.onExit(({ exitCode }) => {
      this.announce(`${this.pending}\n`, events);
      if (this.pty === pty) this.pty = null;
      events.exit(exitCode);
    });
  }

  private announce(text: string, events: TerminalEvents): void {
    for (const url of findUrls(text)) {
      if (this.seen.has(url)) continue;
      this.seen.add(url);
      events.url(url);
    }
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(20, Math.floor(cols));
    this.rows = Math.max(4, Math.floor(rows));
    this.pty?.resize(this.cols, this.rows);
  }

  stop(): void {
    this.pty?.kill();
    this.pty = null;
  }
}
