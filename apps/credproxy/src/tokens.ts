import type { CredentialStatus } from "@nibblet/protocol";
import type { OAuthTokens, ProviderPlugin } from "./providers/provider.ts";
import type { CredentialSource } from "./sources/source.ts";

/** Refresh this long before the token says it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class NoCredentialError extends Error {}

/**
 * Hands out a current access token for one provider. Tokens are cached;
 * a refresh happens when one is near expiry or upstream rejects it, and
 * concurrent callers share a single refresh. Before refreshing, the source
 * is re-read, because the host's own CLI may have refreshed already, and a
 * second refresh with the now-rotated refresh token would fail and could
 * sign the host out.
 */
export class TokenManager {
  readonly provider: ProviderPlugin;
  readonly source: CredentialSource | null;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private cached: OAuthTokens | null = null;
  private inflight: Promise<OAuthTokens> | null = null;
  private lastError: string | null = null;
  /** When the subscription's usage limit resets, in epoch milliseconds. */
  private limitedUntil: number | null = null;

  constructor(opts: {
    provider: ProviderPlugin;
    source: CredentialSource | null;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  }) {
    this.provider = opts.provider;
    this.source = opts.source;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  /** A token that's good for at least the refresh margin. */
  async get(): Promise<OAuthTokens> {
    if (this.cached && this.fresh(this.cached)) return this.cached;
    return this.refresh(null);
  }

  /**
   * Called when upstream rejected `rejected`. Refreshes unless someone has
   * already replaced that token, in which case the newer one is returned.
   */
  async rejected(rejected: string): Promise<OAuthTokens> {
    if (this.cached && this.cached.accessToken !== rejected) return this.cached;
    return this.refresh(rejected);
  }

  /** Records that upstream refused a request until `until` (epoch ms). */
  noteLimit(until: number): void {
    this.limitedUntil = Math.max(until, this.limitedUntil ?? 0);
  }

  /** Upstream served a request, so whatever limit there was has lifted. */
  clearLimit(): void {
    this.limitedUntil = null;
  }

  /** The reset time while a limit is in force, else null. */
  limit(): number | null {
    if (this.limitedUntil !== null && this.limitedUntil <= this.now()) this.limitedUntil = null;
    return this.limitedUntil;
  }

  /** Drops the cache, e.g. after the desktop app pushed a new login. */
  reset(): void {
    this.cached = null;
    this.lastError = null;
  }

  async status(): Promise<CredentialStatus> {
    const until = this.limit();
    const base: Pick<CredentialStatus, "provider" | "source" | "limitedUntil"> = {
      provider: this.provider.id,
      source: this.source?.kind ?? "none",
      limitedUntil: until === null ? null : new Date(until).toISOString(),
    };
    if (!this.source) {
      return {
        ...base,
        ok: false,
        detail: "No credential source configured",
        plan: null,
        expiresAt: null,
      };
    }
    try {
      // Read the source every time, so signing in again on the host (or a
      // fixed login) shows up straight away instead of a stale cached error.
      const loaded = await this.load();
      if (loaded && (!this.cached || loaded.accessToken !== this.cached.accessToken)) {
        this.cached = loaded;
        this.lastError = null;
      }
      const tokens = loaded ?? null;
      if (!tokens) {
        return {
          ...base,
          ok: false,
          detail: `Not signed in (${this.source.describe()})`,
          plan: null,
          expiresAt: null,
        };
      }
      return {
        ...base,
        ok: this.lastError === null,
        detail: this.lastError ?? `Signed in (${this.source.describe()})`,
        plan: tokens.plan,
        expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
      };
    } catch (err) {
      return { ...base, ok: false, detail: message(err), plan: null, expiresAt: null };
    }
  }

  private fresh(tokens: OAuthTokens): boolean {
    return tokens.expiresAt === null || tokens.expiresAt - this.now() > REFRESH_MARGIN_MS;
  }

  private async load(): Promise<OAuthTokens | null> {
    const text = await this.source?.load();
    return text ? this.provider.parse(text) : null;
  }

  private refresh(rejected: string | null): Promise<OAuthTokens> {
    this.inflight ??= this.doRefresh(rejected).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(rejected: string | null): Promise<OAuthTokens> {
    const source = this.source;
    if (!source) throw new NoCredentialError(`No ${this.provider.id} credential source`);
    try {
      const text = await source.load();
      if (!text) throw new NoCredentialError(`Not signed in to ${this.provider.id}`);
      const current = this.provider.parse(text);
      // The host (or an earlier refresh) may already have a good token.
      if (current.accessToken !== rejected && this.fresh(current)) {
        this.cached = current;
        this.lastError = null;
        return current;
      }
      if (!source.writable()) {
        throw new NoCredentialError(
          `The ${this.provider.id} login needs refreshing, but ${source.describe()} can't be written to right now. Open the Nibblets app.`,
        );
      }
      const next = await this.provider.refresh(current, this.fetch);
      await source.save(this.provider.merge(text, next));
      this.cached = next;
      this.lastError = null;
      return next;
    } catch (err) {
      this.lastError = message(err);
      throw err;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
