import { describe, expect, it } from "vitest";
import type { Run } from "../src/clis/cli.ts";
import {
  parseServeStatus,
  parseTailscaleStatus,
  setTailscaleServe,
  tailscaleLogin,
  tailscaleState,
} from "../src/tailscale.ts";

const TARGET = "http://127.0.0.1:8420";
const status = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "pogair.tail1234.ts.net." },
});
const serving = JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { "pogair.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8420" } } } },
});

/** A fake host: Tailscale at the macOS app path, serving once asked to. */
function fakeHost(): { run: Run; calls: string[] } {
  const calls: string[] = [];
  let on = false;
  const run: Run = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (command === "tailscale") return { code: 127, stdout: "", stderr: "not found" };
    if (args[0] === "version") return ok("1.90.0");
    if (args.join(" ") === "status --json") return ok(status);
    if (args.join(" ") === "serve status --json") return ok(on ? serving : "{}");
    if (args.includes("--bg")) on = true;
    if (args.includes("off")) on = false;
    return ok();
  };
  return { run, calls };
}

describe("tailscale", () => {
  it("reads the machine's MagicDNS name", () => {
    expect(parseTailscaleStatus(status)).toEqual({
      reachable: true,
      running: true,
      dnsName: "pogair.tail1234.ts.net",
      authUrl: null,
    });
    expect(parseTailscaleStatus("not json")).toMatchObject({ reachable: false, running: false });
  });

  it("knows whether the server is being served", () => {
    expect(parseServeStatus(serving, TARGET)).toBe(true);
    expect(parseServeStatus(serving, "http://127.0.0.1:9999")).toBe(false);
    expect(parseServeStatus("{}", TARGET)).toBe(false);
  });

  it("finds the macOS app's CLI and turns serving on and off", async () => {
    const host = fakeHost();
    expect(await tailscaleState(host.run, TARGET)).toMatchObject({
      installed: true,
      serving: false,
    });
    const on = await setTailscaleServe(host.run, TARGET, true);
    expect(on).toMatchObject({ serving: true, url: "https://pogair.tail1234.ts.net" });
    expect(host.calls).toContain(
      `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 ${TARGET}`,
    );
    expect(await setTailscaleServe(host.run, TARGET, false)).toMatchObject({
      serving: false,
      url: null,
    });
  });

  it("says when Tailscale isn't installed", async () => {
    const none: Run = async () => ({ code: 127, stdout: "", stderr: "" });
    expect(await tailscaleState(none, TARGET)).toMatchObject({ installed: false, running: false });
  });

  it("passes on the link to turn Serve on when the tailnet hasn't", async () => {
    const run: Run = async (command, args) => {
      if (command === "tailscale" && args[0] === "version")
        return { code: 0, stdout: "1.104.1", stderr: "" };
      if (args.join(" ") === "status --json") return { code: 0, stdout: status, stderr: "" };
      if (args.join(" ") === "serve status --json") return { code: 0, stdout: "{}", stderr: "" };
      return {
        code: 1,
        stdout: "",
        stderr:
          "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n",
      };
    };
    const state = await setTailscaleServe(run, TARGET, true);
    expect(state.detail).toBe("Serve isn't turned on for your tailnet yet.");
    expect(state.action).toEqual({
      label: "Turn on Serve",
      url: "https://login.tailscale.com/f/serve?node=abc",
    });
  });

  it("hands back the sign-in link as an action", async () => {
    const run: Run = async (command, args) => {
      if (command !== "tailscale") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "version") return { code: 0, stdout: "1.104.1", stderr: "" };
      if (args.join(" ") === "status --json") {
        return { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1234abcd\n",
      };
    };
    const state = await tailscaleLogin(run, TARGET);
    expect(state.action).toEqual({
      label: "Sign in to Tailscale",
      url: "https://login.tailscale.com/a/1234abcd",
    });
  });

  it("says when Tailscale is installed but its service isn't running, without trying to sign in", async () => {
    const calls: string[] = [];
    const run: Run = async (command, args) => {
      calls.push(args.join(" "));
      if (command !== "tailscale") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "version") return { code: 0, stdout: "1.104.1", stderr: "" };
      return {
        code: 1,
        stdout: "",
        stderr: "failed to connect to local Tailscale service; is Tailscale running?\n",
      };
    };
    const state = await tailscaleLogin(run, TARGET);
    expect(state).toMatchObject({ installed: true, running: false, stopped: true, action: null });
    expect(state.detail).toMatch(/isn't running/);
    expect(calls).not.toContain("up --timeout=8s");
  });

  it("reuses a sign-in that's already waiting", async () => {
    const calls: string[] = [];
    const run: Run = async (command, args) => {
      calls.push(args.join(" "));
      if (command !== "tailscale") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "version") return { code: 0, stdout: "1.104.1", stderr: "" };
      const waiting = { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/w8" };
      return { code: 0, stdout: JSON.stringify(waiting), stderr: "" };
    };
    const state = await tailscaleLogin(run, TARGET);
    expect(state.action).toEqual({
      label: "Sign in to Tailscale",
      url: "https://login.tailscale.com/a/w8",
    });
    expect(calls).not.toContain("up --timeout=8s");
  });

  it("passes on why tailscale up gave no link", async () => {
    const run: Run = async (command, args) => {
      if (command !== "tailscale") return { code: 127, stdout: "", stderr: "" };
      if (args[0] === "version") return { code: 0, stdout: "1.104.1", stderr: "" };
      if (args.join(" ") === "status --json") {
        return { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "Error: changing settings via 'tailscale up' requires mentioning all\n",
      };
    };
    const state = await tailscaleLogin(run, TARGET);
    expect(state.action).toBeNull();
    expect(state.detail).toBe(
      "tailscale up failed: Error: changing settings via 'tailscale up' requires mentioning all",
    );
  });
});
