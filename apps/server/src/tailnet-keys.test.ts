import { createHash } from "node:crypto";
import { MASKED } from "@nibblets/protocol";
import { describe, expect, it } from "vitest";
import type { Store } from "./store.ts";
import { keyDescription, keyId, mintAuthKey, setTailnetKeys, tailnetKeys } from "./tailnet-keys.ts";

const oauth = { clientId: "k123", clientSecret: "tskey-client-k123-secret", tags: ["tag:nibblet"] };

function memoryStore(): Store {
  const settings = new Map<string, unknown>();
  return {
    getSetting: async <T>(key: string, parse: (v: unknown) => T, fallback: T) =>
      settings.has(key) ? parse(settings.get(key)) : fallback,
    setSetting: async (key: string, value: unknown) => void settings.set(key, value),
    deleteSetting: async (key: string) => void settings.delete(key),
  } as unknown as Store;
}

/** Tailscale's API, as far as these calls go. */
function tailscaleApi(opts: { badSecret?: boolean } = {}) {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/oauth/token")) {
      return opts.badSecret
        ? Response.json({ error_description: "invalid client secret" }, { status: 401 })
        : Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.endsWith("/tailnet/-/keys")) return Response.json({ id: "k1", key: "tskey-auth-new" });
    return new Response(null, { status: 404 });
  };
  return { calls, fetcher };
}

describe("keys made with the OAuth client", () => {
  it("are single use, pre-approved, tagged and an hour long", async () => {
    const api = tailscaleApi();
    expect(await mintAuthKey(oauth, "Flight watcher ✈️", api.fetcher)).toBe("tskey-auth-new");
    const [token, key] = api.calls;
    expect(new URLSearchParams(token?.body).get("client_secret")).toBe(oauth.clientSecret);
    expect(key?.auth).toBe("Bearer tok");
    expect(JSON.parse(key?.body ?? "")).toEqual({
      capabilities: {
        devices: {
          create: { reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:nibblet"] },
        },
      },
      expirySeconds: 3600,
      description: "nibblet Flight watcher",
    });
  });

  it("are described the way Tailscale takes", () => {
    expect(keyDescription("Pip_2 (home)")).toBe("nibblet Pip 2 home");
    expect(keyDescription("x".repeat(80))).toHaveLength(50);
  });

  it("stand for their source, so a new key or client signs in again", () => {
    expect(keyId("tskey-auth-a", oauth)).not.toBe(keyId("tskey-auth-b", oauth));
    expect(keyId("", oauth)).not.toBe(keyId("", { ...oauth, clientId: "k456" }));
    expect(keyId("", null)).toBeNull();
    // What containers marked themselves with before there were OAuth clients.
    const old = createHash("sha256").update("tskey-auth-a").digest("hex");
    expect(keyId("tskey-auth-a", null)).toBe(old);
    expect(keyId("tskey-auth-a", oauth)).toBe(old);
  });
});

describe("saving the OAuth client", () => {
  it("checks it with Tailscale, keeps its secret on a masked save, and masks it", async () => {
    const store = memoryStore();
    const api = tailscaleApi();
    expect(await setTailnetKeys(store, { oauth }, api.fetcher)).toEqual({
      oauth: { ...oauth, clientSecret: MASKED },
    });
    await setTailnetKeys(
      store,
      { oauth: { ...oauth, clientSecret: MASKED, tags: ["tag:bots"] } },
      api.fetcher,
    );
    expect(new URLSearchParams(api.calls[1]?.body).get("client_secret")).toBe(oauth.clientSecret);
    expect((await tailnetKeys(store)).oauth?.tags).toEqual(["tag:bots"]);
    expect(await setTailnetKeys(store, { oauth: null }, api.fetcher)).toEqual({ oauth: null });
    expect(await tailnetKeys(store)).toEqual({ oauth: null });
  });

  it("isn't saved when Tailscale turns it down", async () => {
    const store = memoryStore();
    await expect(
      setTailnetKeys(store, { oauth }, tailscaleApi({ badSecret: true }).fetcher),
    ).rejects.toThrow("invalid client secret");
    expect(await tailnetKeys(store)).toEqual({ oauth: null });
  });
});
