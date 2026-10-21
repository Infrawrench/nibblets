import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stripe, STRIPE_VERSION } from "./index.ts";
import { stripePurchaseHook } from "./purchases.ts";

const SECRET = "whsec_test_secret";
const now = new Date("2026-10-21T12:00:00Z");
const nowSeconds = now.getTime() / 1000;

const hook = stripePurchaseHook({
  secret: SECRET,
  currency: "usd",
  version: STRIPE_VERSION,
  now: () => now,
});

function event(more: { type?: string; currency?: string; amount?: number } = {}) {
  return JSON.stringify({
    id: "evt_1",
    object: "event",
    type: more.type ?? "issuing_authorization.request",
    data: {
      object: {
        id: "iauth_1",
        object: "issuing.authorization",
        amount: 0,
        approved: false,
        card: { id: "ic_1", object: "issuing.card", last4: "4242" },
        merchant_data: { name: "Rocket Rides", category: "taxicabs_limousines" },
        pending_request: {
          amount: more.amount ?? 1250,
          currency: more.currency ?? "usd",
          merchant_amount: 1250,
          merchant_currency: "usd",
        },
      },
    },
  });
}

/** A request as Stripe sends it, signed `t=…,v1=…`. */
function signed(body: string, opts: { secret?: string; at?: number } = {}) {
  const t = opts.at ?? nowSeconds;
  const v1 = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return { headers: new Headers({ "stripe-signature": `t=${t},v1=${v1}` }), body };
}

describe("stripe purchases", () => {
  it("reads a signed authorization request", () => {
    expect(hook.read(signed(event()))).toEqual({
      ref: "ic_1",
      amount: 1250n,
      merchant: "Rocket Rides",
    });
  });

  it("takes any of several signatures, as Stripe sends while a secret's being rolled", () => {
    const body = event();
    const good = signed(body).headers.get("stripe-signature") ?? "";
    const old = signed(body, { secret: "whsec_old" }).headers.get("stripe-signature") ?? "";
    const header = `${old},${good.split(",")[1]}`;
    expect(
      hook.read({ headers: new Headers({ "stripe-signature": header }), body }),
    ).not.toBeNull();
  });

  it("isn't fooled by another secret, a changed body, an old signature or none", () => {
    expect(hook.read(signed(event(), { secret: "whsec_other" }))).toBeNull();
    const tampered = signed(event());
    expect(hook.read({ ...tampered, body: event({ amount: 1 }) })).toBeNull();
    expect(hook.read(signed(event(), { at: nowSeconds - 301 }))).toBeNull();
    expect(hook.read({ headers: new Headers(), body: event() })).toBeNull();
    expect(
      hook.read({ headers: new Headers({ "stripe-signature": "t=x,v1=zz" }), body: event() }),
    ).toBeNull();
  });

  it("throws on a signed request it can't answer, so the server declines it", () => {
    expect(() => hook.read(signed(event({ type: "issuing_card.created" })))).toThrow();
    expect(() => hook.read(signed(event({ currency: "eur" })))).toThrow(/eur/);
  });

  it("answers in the shape and version Stripe wants", () => {
    expect(hook.answer(true)).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "stripe-version": STRIPE_VERSION },
      body: '{"approved":true}',
    });
    expect(hook.answer(false).body).toBe('{"approved":false}');
  });

  it("is on only once the webhook's secret is set", () => {
    const deps = { fetch: globalThis.fetch, log: () => {} };
    const settings = { STRIPE_API_KEY: "sk_test_1", STRIPE_CARDHOLDER_ID: "ich_1" };
    expect(stripe.fromSettings(settings, deps)?.purchases).toBeUndefined();
    expect(
      stripe.fromSettings({ ...settings, STRIPE_WEBHOOK_SECRET: SECRET }, deps)?.purchases,
    ).toBeDefined();
    expect(() =>
      stripe.fromSettings({ ...settings, STRIPE_WEBHOOK_SECRET: "sk_test_1" }, deps),
    ).toThrow(/whsec_/);
    expect(stripe.purchaseHook?.where).toContain("real-time authorizations");
  });
});
