import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSshPlugin, keyFiles, parseSshAddList } from "../src/clis/ssh.ts";
import type { Run } from "../src/clis/cli.ts";

const calls: string[] = [];
const fake =
  (answers: Record<string, { code: number; stdout?: string }>): Run =>
  async (command, args) => {
    calls.push([command, ...args].join(" "));
    const a = answers[[command, ...args].join(" ")] ?? { code: 127 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: "" };
  };

const withKeys = mkdtempSync(join(tmpdir(), "ssh-keys-"));
for (const f of ["id_ed25519", "id_ed25519.pub", "work", "work.pub", "known_hosts", "config"]) {
  writeFileSync(join(withKeys, f), "");
}
const empty = mkdtempSync(join(tmpdir(), "ssh-empty-"));
afterAll(() => {
  rmSync(withKeys, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

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

  it("finds key pairs on disk, not other files", () => {
    expect(keyFiles(withKeys).map((f) => f.slice(withKeys.length + 1))).toEqual([
      "id_ed25519",
      "work",
    ]);
  });

  it("offers keys on disk even when the agent is empty", async () => {
    const found = await createSshPlugin(withKeys).detect(
      fake({ "ssh -V": { code: 0 }, "ssh-add -l": { code: 1 } }),
    );
    expect(found).toMatchObject({ installed: true, signedIn: true, account: "2 keys" });
  });

  it("explains when there are no keys anywhere", async () => {
    const none = await createSshPlugin(empty).detect(
      fake({ "ssh -V": { code: 0 }, "ssh-add -l": { code: 2 } }),
    );
    expect(none).toMatchObject({ signedIn: false, detail: "No SSH agent is running on the host" });
    expect((await createSshPlugin(empty).detect(fake({}))).installed).toBe(false);
  });

  it("loads the keys into the host's agent and hands over its socket, never a key", async () => {
    calls.length = 0;
    const cred = await createSshPlugin(withKeys).credential(fake({}));
    expect(cred.env).toEqual({ SSH_AUTH_SOCK: "/run/nibblet/ssh-agent.sock" });
    expect(calls).toContain(`ssh-add -q ${join(withKeys, "id_ed25519")}`);
    expect(calls).toContain(`ssh-add -q ${join(withKeys, "work")}`);
  });
});
