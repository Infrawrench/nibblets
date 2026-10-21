import type { HookRequest, Purchase, PurchaseHook } from "@nibblet/bank";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** How old a signed request can be, as Stripe's own libraries allow. */
const TOLERANCE_SECONDS = 300;

const AuthorizationRequest = z.object({
  type: z.literal("issuing_authorization.request"),
  data: z.object({
    object: z.object({
      id: z.string(),
      card: z.object({ id: z.string() }),
      pending_request: z.object({ amount: z.number().int().min(0), currency: z.string() }),
      merchant_data: z.object({ name: z.string().nullable() }).optional(),
    }),
  }),
});

export interface PurchaseHookOptions {
  /** The webhook's signing secret, `whsec_…`. */
  secret: string;
  currency: string;
  /** The Stripe-Version the answer is in. */
  version: string;
  now?: () => Date;
}

/**
 * Stripe's real-time authorizations: Stripe asks before each purchase on
 * one of the account's cards, signed with the webhook's secret, and waits
 * two seconds for `{ approved }` before falling back to the account's own
 * setting (which should be to decline).
 */
export function stripePurchaseHook(options: PurchaseHookOptions): PurchaseHook {
  const now = options.now ?? (() => new Date());

  /** Whether Stripe signed this body with our secret, recently (`t=…,v1=…`). */
  function signed(request: HookRequest): boolean {
    const header = request.headers.get("stripe-signature") ?? "";
    const parts = header.split(",").map((p) => p.split("=", 2));
    const time = Number(parts.find(([k]) => k === "t")?.[1]);
    if (!Number.isInteger(time)) return false;
    if (Math.abs(now().getTime() / 1000 - time) > TOLERANCE_SECONDS) return false;
    const expected = createHmac("sha256", options.secret)
      .update(`${time}.${request.body}`)
      .digest();
    return parts.some(([k, v]) => {
      if (k !== "v1" || !v || !/^[0-9a-f]{64}$/.test(v)) return false;
      return timingSafeEqual(Buffer.from(v, "hex"), expected);
    });
  }

  return {
    read(request): Purchase | null {
      if (!signed(request)) return null;
      const event = AuthorizationRequest.parse(JSON.parse(request.body));
      const { card, pending_request: pending, merchant_data: merchant } = event.data.object;
      if (pending.currency !== options.currency) {
        throw new Error(
          `Stripe asked about a purchase in ${pending.currency} on a card in ${options.currency}`,
        );
      }
      return {
        ref: card.id,
        amount: BigInt(pending.amount),
        merchant: merchant?.name ?? "an unnamed merchant",
      };
    },

    answer(approved) {
      return {
        status: 200,
        headers: { "content-type": "application/json", "stripe-version": options.version },
        body: JSON.stringify({ approved }),
      };
    },
  };
}
