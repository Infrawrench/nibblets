import { describe, expect, it } from "vitest";
import type { Run } from "../src/clis/cli.ts";
import {
  parseServeStatus,
  parseTailscaleStatus,
  setTailscaleServe,
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
      running: true,
      dnsName: "pogair.tail1234.ts.net",
    });
    expect(parseTailscaleStatus("not json").running).toBe(false);
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
});
