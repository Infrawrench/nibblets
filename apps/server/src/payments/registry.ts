import type { PaymentProviderInfo } from "@nibblet/protocol";
import { MercuryProvider } from "./mercury.ts";
import type { CardProvider, PaymentProvider } from "./provider.ts";

/** Every payment provider the server knows, by id. New banks and wallets go here. */
export class PaymentRegistry {
  private readonly providers: Map<string, PaymentProvider>;

  constructor(providers: readonly PaymentProvider[]) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  get(id: string): PaymentProvider | null {
    return this.providers.get(id) ?? null;
  }

  card(id: string): CardProvider | null {
    const p = this.get(id);
    return p?.kind === "card" ? p : null;
  }

  /** What the "Add account" form offers: everything but hidden providers. */
  visible(): PaymentProviderInfo[] {
    return [...this.providers.values()]
      .filter((p) => !p.hidden)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        label: p.label,
        description: p.description,
        credentialFields: p.credentialFields,
      }));
  }
}

export function defaultRegistry(): PaymentRegistry {
  return new PaymentRegistry([new MercuryProvider()]);
}
