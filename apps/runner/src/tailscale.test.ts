import { describe, expect, it } from "vitest";
import {
  nodeFromStatus,
  TAILSCALE_USER,
  tailscaleClient,
  tailscaleHost,
  why,
} from "./tailscale.ts";

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
  const env = {
    NIBBLET_ID: "nib_1",
    NIBBLET_SERVER_URL: "http://server:8420",
    NIBBLET_GUARD_TOKEN: "g",
  };

  it("fetches the login, a key when it must, and reports, with the guard's token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/key")) return Response.json({ authKey: "tskey-auth-x" });
      return init?.method === "POST"
        ? Response.json({ ok: true })
        : Response.json({ hostname: "scamp", ports: [3000], keyId: "abc" });
    };
    const client = tailscaleClient(env, fetcher);
    expect(await client.login()).toEqual({ hostname: "scamp", ports: [3000], keyId: "abc" });
    expect(await client.authKey()).toBe("tskey-auth-x");
    await client.report({ state: "starting", dnsName: null, ips: [], tailnet: null, detail: null });
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET http://server:8420/guard/nib_1/tailscale",
      "POST http://server:8420/guard/nib_1/tailscale/key",
      "POST http://server:8420/guard/nib_1/tailscale",
    ]);
    for (const call of calls)
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer g");
  });

  it("passes on why there's no key", async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({ error: "no OAuth client" }, { status: 409 });
    await expect(tailscaleClient(env, fetcher).authKey()).rejects.toThrow("no OAuth client");
  });
});

describe("Tailscale on Windows", () => {
  const host = tailscaleHost("win32");

  it("listens where only an administrator could have, so nothing can pose as it for the key", () => {
    expect(host.socket).toMatch(/^\\\\\.\\pipe\\ProtectedPrefix\\Administrators\\/);
  });

  it("is run by a user of its own, who keeps it, so the agent can't use it", () => {
    expect(host.cli.args[0]).toBe(TAILSCALE_USER);
    expect(host.cli.command).toMatch(/nibblet-runas\.exe$/);
    expect(host.up).toEqual(["--unattended"]);
  });

  it("is as it was everywhere else", () => {
    const linux = tailscaleHost("linux");
    expect(linux.cli).toEqual({ command: "tailscale", args: [] });
    expect(linux.up).toEqual([]);
  });
});

describe("Tailscale on macOS", () => {
  const host = tailscaleHost("darwin");

  it("runs the image's own build, with its socket in its own folder and its state outside the home", () => {
    expect(host.tailscaled).toBe("/Library/Nibblets/tailscale/tailscaled");
    expect(host.cli.command).toBe("/Library/Nibblets/tailscale/tailscale");
    expect(host.socket.startsWith(`${host.run}/`)).toBe(true);
    expect(host.state.startsWith("/Users/")).toBe(false);
  });
});
