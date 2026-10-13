import { describe, expect, it } from "vitest";
import { ghPlugin, parseGhStatus, type Run } from "../src/clis/index.ts";

const STATUS = `github.com
  ✓ Logged in to github.com account astrid (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************`;

const fakeRun =
  (results: Record<string, { code: number; stdout?: string; stderr?: string }>): Run =>
  async (cmd, args) => {
    const r = results[[cmd, ...args].join(" ")] ?? { code: 127 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

describe("parseGhStatus", () => {
  it("reads the host and account from stdout or stderr, old wording or new", () => {
    expect(parseGhStatus({ code: 0, stdout: STATUS, stderr: "" })).toEqual({
      host: "github.com",
      account: "astrid",
    });
    expect(
      parseGhStatus({
        code: 0,
        stdout: "",
        stderr: "✓ Logged in to ghe.acme.dev as bob (oauth_token)",
      }),
    ).toEqual({ host: "ghe.acme.dev", account: "bob" });
    expect(
      parseGhStatus({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." }),
    ).toBeNull();
  });
});

describe("ghPlugin", () => {
  it("reports not installed when gh can't run", async () => {
    expect(await ghPlugin.detect(fakeRun({}))).toMatchObject({ installed: false, signedIn: false });
  });

  it("reports installed but signed out", async () => {
    const run = fakeRun({
      "gh --version": { code: 0, stdout: "gh version 2.86.0" },
      "gh auth status --active": { code: 1 },
    });
    expect(await ghPlugin.detect(run)).toMatchObject({
      installed: true,
      signedIn: false,
      account: null,
    });
  });

  it("detects the account and hands out its token as GH_TOKEN", async () => {
    const run = fakeRun({
      "gh --version": { code: 0 },
      "gh auth status --active": { code: 0, stdout: STATUS },
      "gh auth token --hostname github.com": { code: 0, stdout: "gho_secret\n" },
    });
    expect(await ghPlugin.detect(run)).toMatchObject({ signedIn: true, account: "astrid" });
    expect(await ghPlugin.credential(run)).toEqual({
      env: { GH_TOKEN: "gho_secret", GITHUB_TOKEN: "gho_secret" },
      setup: [["gh", "auth", "setup-git"]],
    });
  });

  it("refuses to hand out a credential when signed out", async () => {
    await expect(ghPlugin.credential(fakeRun({}))).rejects.toThrow(/isn't signed in/);
  });
});
