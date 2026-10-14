import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserSignIn } from "./browser-sign-in.ts";

const CENTRAL = "https://app.nibblets.dev/";

/** Connect's redeem endpoint: hands over the ticket for the verifier behind `challenge`. */
function connect(challenge: () => string) {
  const calls: unknown[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body: { handle: string; verifier: string } = JSON.parse(String(init?.body));
    calls.push(body);
    const ok = createHash("sha256").update(body.verifier).digest("hex") === challenge();
    return new Response(JSON.stringify(ok ? { ticket: "the-ticket" } : { error: "no" }), {
      status: ok ? 200 : 400,
    });
  };
  return { fetcher, calls };
}

describe("signing in through the browser", () => {
  it("opens Connect with a challenge, and collects the ticket with the secret behind it", async () => {
    let challenge = "";
    const { fetcher } = connect(() => challenge);
    const signIn = new BrowserSignIn({ fetch: fetcher });
    const page = new URL(signIn.start(CENTRAL));
    expect(page.pathname).toBe("/desktop-sign-in");
    challenge = page.searchParams.get("challenge") ?? "";
    const state = page.searchParams.get("state") ?? "";
    expect(await signIn.finish(CENTRAL, { state, handle: "h" })).toBe("the-ticket");
    // Once only.
    expect(await signIn.finish(CENTRAL, { state, handle: "h" })).toBeNull();
  });

  it("ignores a sign-in it didn't start", async () => {
    const { fetcher, calls } = connect(() => "");
    const signIn = new BrowserSignIn({ fetch: fetcher });
    expect(await signIn.finish(CENTRAL, { state: "s", handle: "h" })).toBeNull();
    signIn.start(CENTRAL);
    expect(await signIn.finish(CENTRAL, { state: "someone-elses", handle: "h" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("gives up on one that took too long", async () => {
    let now = 0;
    const { fetcher, calls } = connect(() => "");
    const signIn = new BrowserSignIn({ fetch: fetcher, now: () => now });
    const state = new URL(signIn.start(CENTRAL)).searchParams.get("state") ?? "";
    now = 60 * 60_000;
    expect(await signIn.finish(CENTRAL, { state, handle: "h" })).toBeNull();
    expect(calls).toEqual([]);
  });
});
