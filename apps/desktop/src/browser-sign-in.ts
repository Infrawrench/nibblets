import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** How long a sign-in started in the browser may take to come back. */
const PENDING_FOR_MS = 15 * 60_000;

const Redeemed = z.object({ ticket: z.string() });

/** Why a sign-in coming back from the browser didn't go through. */
export type FinishFailure = "unknown" | "expired" | "refused";

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
  /**
   * Every sign-in still waiting, by state. One click can open the browser
   * more than once (Clerk may both link and redirect to Google), and any of
   * those tabs may be the one finished, so none replaces another.
   */
  private readonly pending = new Map<string, { verifier: string; startedAt: number }>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The page to open in the browser. */
  start(centralUrl: string): string {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const now = this.now();
    for (const [key, p] of this.pending) {
      if (now - p.startedAt > PENDING_FOR_MS) this.pending.delete(key);
    }
    this.pending.set(state, { verifier, startedAt: now });
    const url = new URL("/desktop-sign-in", centralUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("challenge", createHash("sha256").update(verifier).digest("hex"));
    return url.href;
  }

  /**
   * The Clerk ticket for a sign-in coming back, or why there isn't one:
   * "unknown" when this app didn't start it (or already used it).
   */
  async finish(
    centralUrl: string,
    back: { state: string; handle: string },
  ): Promise<{ ticket: string } | { failed: FinishFailure }> {
    const pending = this.pending.get(back.state);
    if (!pending) return { failed: "unknown" };
    this.pending.delete(back.state);
    if (this.now() - pending.startedAt > PENDING_FOR_MS) return { failed: "expired" };
    const res = await this.fetch(new URL("/v1/desktop/sign-in/redeem", centralUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: back.handle, verifier: pending.verifier }),
    });
    if (!res.ok) return { failed: "refused" };
    return { ticket: Redeemed.parse(await res.json()).ticket };
  }
}
