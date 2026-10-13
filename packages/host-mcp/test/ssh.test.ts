import { describe, expect, it } from "vitest";
import { parseSshAddList, sshPlugin } from "../src/clis/ssh.ts";
import type { Run } from "../src/clis/cli.ts";

const fake =
  (answers: Record<string, { code: number; stdout?: string }>): Run =>
  async (command, args) => {
    const a = answers[[command, ...args].join(" ")] ?? { code: 127 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: "" };
  };

describe("ssh plugin", () => {
  it("parses ssh-add -l", () => {
    expect(
      parseSshAddList({
        code: 0,
        stdout: "256 SHA256:abc astrid@mac (ED25519)\n3072 SHA256:def work key (RSA)\n",
        stderr: "",
      }),
    ).toEqual([
      { comment: "astrid@mac", type: "ed25519" },
      { comment: "work key", type: "rsa" },
    ]);
  });

  it("is signed in only when the agent holds keys", async () => {
    const withKey = await sshPlugin.detect(
      fake({
        "ssh -V": { code: 0 },
        "ssh-add -l": { code: 0, stdout: "256 SHA256:abc astrid@mac (ED25519)\n" },
      }),
    );
    expect(withKey).toMatchObject({
      installed: true,
      signedIn: true,
      account: "astrid@mac (ed25519)",
    });

    const noAgent = await sshPlugin.detect(
      fake({ "ssh -V": { code: 0 }, "ssh-add -l": { code: 2 } }),
    );
    expect(noAgent).toMatchObject({
      signedIn: false,
      detail: "No SSH agent is running on the host",
    });

    const missing = await sshPlugin.detect(fake({}));
    expect(missing.installed).toBe(false);
  });

  it("hands over the agent's socket, never a key", async () => {
    const cred = await sshPlugin.credential(fake({}));
    expect(cred.env).toEqual({ SSH_AUTH_SOCK: "/run/nibblet/ssh-agent.sock" });
  });
});
