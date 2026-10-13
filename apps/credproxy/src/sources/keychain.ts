import { defineSource, type CredentialSource } from "./source.ts";

/**
 * The macOS keychain, reached through the desktop app's bridge on the host
 * (a container can't open the keychain itself). The desktop app also pushes
 * the document in on start through `PUT /admin/credentials/:provider`, which
 * lands in `remember`, so the proxy works even if the bridge is briefly away.
 */
export function keychainSource(opts: {
  provider: string;
  bridgeUrl: string | null;
  bridgeToken: string | null;
  fetch?: typeof fetch;
}): CredentialSource & { remember(text: string): void } {
  const doFetch = opts.fetch ?? fetch;
  let pushed: string | null = null;
  let bridgeUp = false;
  const url = opts.bridgeUrl ? `${opts.bridgeUrl.replace(/\/$/, "")}/${opts.provider}` : null;
  const headers = (): Record<string, string> =>
    opts.bridgeToken ? { authorization: `Bearer ${opts.bridgeToken}` } : {};

  const source = defineSource({
    kind: "keychain",
    async load() {
      if (!url) return pushed;
      try {
        const res = await doFetch(url, { headers: headers() });
        if (res.status === 404) {
          bridgeUp = true;
          return pushed;
        }
        if (!res.ok) throw new Error(`bridge answered ${res.status}`);
        pushed = await res.text();
        bridgeUp = true;
        return pushed;
      } catch (err) {
        bridgeUp = false;
        // The bridge lives in the desktop app; when it's closed, use what it
        // last pushed rather than failing every request.
        if (pushed !== null) return pushed;
        throw err;
      }
    },
    async save(text) {
      pushed = text;
      if (!url) return;
      const res = await doFetch(url, {
        method: "PUT",
        headers: { ...headers(), "content-type": "application/json" },
        body: text,
      });
      if (!res.ok) throw new Error(`bridge refused the write: ${res.status}`);
    },
    writable: () => url !== null && bridgeUp,
    describe: () =>
      url ? `keychain via ${opts.bridgeUrl}` : "keychain (pushed by the desktop app)",
  });
  return {
    ...source,
    remember(text: string) {
      pushed = text;
    },
  };
}
