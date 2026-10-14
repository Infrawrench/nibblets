import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** How long a sign-in started in the browser may take to come back. */
const PENDING_FOR_MS = 15 * 60_000;

const Redeemed = z.object({ ticket: z.string() });

/**
 * Signing in to Nibblets Connect in the person's own browser, for the
 * sign-ins (Google's especially) that won't happen inside the app's window.
 *
 * Like OAuth for native apps (PKCE): the app keeps a secret and sends only
 * its hash. The browser, once signed in, leaves a sign-in for that hash on
 * Connect and passes a handle back through the app's `nibblets:` link. The
 * app collects the sign-in with the handle and the secret, so a link that
 * reached anything else is no use to it, and the state stops a sign-in the
 * app didn't ask for (someone else's) from being accepted.
 */
export class BrowserSignIn {
  private pending: { state: string; verifier: string; startedAt: number } | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The page to open in the browser. Starting again replaces any sign-in still waiting. */
  start(centralUrl: string): string {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    this.pending = { state, verifier, startedAt: this.now() };
    const url = new URL("/desktop-sign-in", centralUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("challenge", createHash("sha256").update(verifier).digest("hex"));
    return url.href;
  }

  /** The Clerk ticket for a sign-in coming back, or null when it isn't the one this app started. */
  async finish(
    centralUrl: string,
    back: { state: string; handle: string },
  ): Promise<string | null> {
    const pending = this.pending;
    if (!pending || pending.state !== back.state) return null;
    this.pending = null;
    if (this.now() - pending.startedAt > PENDING_FOR_MS) return null;
    const res = await this.fetch(new URL("/v1/desktop/sign-in/redeem", centralUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: back.handle, verifier: pending.verifier }),
    });
    if (!res.ok) return null;
    return Redeemed.parse(await res.json()).ticket;
  }
}
