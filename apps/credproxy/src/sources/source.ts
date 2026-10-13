/**
 * Where a provider's credential document lives. A source deals in the raw
 * JSON text exactly as the host's CLI stores it, so whatever fields we don't
 * understand survive a refresh untouched. Parsing belongs to the provider.
 */
export interface CredentialSource {
  readonly kind: "file" | "keychain";
  /** The document, or null when there isn't one yet. */
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
  /**
   * Whether a save would reach the real store right now. Refreshing rotates
   * the refresh token, so refreshing when the new one can't be written back
   * would sign the host's own CLI out. Checked after a load.
   */
  writable(): boolean;
  /** For the status page: where this source reads from. */
  describe(): string;
}

export function defineSource(source: CredentialSource): CredentialSource {
  return source;
}
