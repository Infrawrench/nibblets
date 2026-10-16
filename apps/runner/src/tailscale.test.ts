import { describe, expect, it } from "vitest";
import { nodeFromStatus, tailscaleClient, why } from "./tailscale.ts";

describe("its machine on the tailnet", () => {
  it("is running once Tailscale says so, with its name and addresses", () => {
    const status = {
      BackendState: "Running",
      Self: { DNSName: "scamp.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c::7"] },
      CurrentTailnet: { Name: "astrid@example.com", MagicDNSSuffix: "tail1234.ts.net" },
    };
    expect(nodeFromStatus(JSON.stringify(status))).toEqual({
      state: "running",
      dnsName: "scamp.tail1234.ts.net",
      ips: ["100.64.0.7", "fd7a:115c::7"],
      tailnet: "astrid@example.com",
      detail: null,
    });
  });

  it("needs a new key, or the admin's approval, when it can't sign in", () => {
    expect(nodeFromStatus('{"BackendState":"NeedsLogin"}')).toMatchObject({
      state: "needs_login",
      detail: expect.stringContaining("auth key"),
    });
    expect(nodeFromStatus('{"BackendState":"NeedsMachineAuth"}')).toMatchObject({
      state: "needs_login",
      detail: expect.stringContaining("admin console"),
    });
  });

  it("is still starting when there's nothing to read", () => {
    expect(nodeFromStatus("")).toMatchObject({ state: "starting" });
    expect(nodeFromStatus('{"BackendState":"Starting"}')).toMatchObject({ state: "starting" });
  });

  it("says why a command failed in a line", () => {
    expect(why({ stderr: "\nbackend error: invalid key\nmore\n" })).toBe(
      "backend error: invalid key",
    );
    expect(why(new Error("spawn tailscale ENOENT"))).toBe("spawn tailscale ENOENT");
  });
});

describe("talking to the server", () => {
  it("fetches the login and reports with the guard's token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return init?.method === "POST"
        ? Response.json({ ok: true })
        : Response.json({ authKey: "tskey-auth-x", hostname: "scamp", ports: [3000] });
    };
    const client = tailscaleClient(
      { NIBBLET_ID: "nib_1", NIBBLET_SERVER_URL: "http://server:8420", NIBBLET_GUARD_TOKEN: "g" },
      fetcher,
    );
    expect(await client.login()).toEqual({
      authKey: "tskey-auth-x",
      hostname: "scamp",
      ports: [3000],
    });
    await client.report({ state: "starting", dnsName: null, ips: [], tailnet: null, detail: null });
    expect(calls.map((c) => c.url)).toEqual([
      "http://server:8420/guard/nib_1/tailscale",
      "http://server:8420/guard/nib_1/tailscale",
    ]);
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe("Bearer g");
  });
});
