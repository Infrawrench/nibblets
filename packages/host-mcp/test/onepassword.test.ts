import { describe, expect, it } from "vitest";
import type { Run } from "../src/clis/cli.ts";
import {
  fingerprint,
  onePasswordStatus,
  OnePasswordGrantsManager,
  vaultFlags,
  type TokenStore,
} from "../src/onepassword.ts";

type Answer = { code: number; stdout?: string; stderr?: string };

function fakeRun(answers: (args: string[]) => Answer | undefined) {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    const a = answers([command, ...args]) ?? { code: 127 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

const connected = (args: string[]): Answer | undefined => {
  const cmd = args.join(" ");
  if (cmd === "op --version") return { code: 0, stdout: "2.32.0" };
  if (cmd === "op account list --format json")
    return {
      code: 0,
      stdout: JSON.stringify([{ email: "astrid@infrawrench.com", url: "my.1password.com" }]),
    };
  if (cmd === "op vault list --format json")
    return {
      code: 0,
      stdout: JSON.stringify([
        { id: "v1", name: "Private", type: "PERSONAL" },
        { id: "v2", name: "Nibblets", type: "USER_CREATED" },
        { id: "v3", name: "Banking", type: "USER_CREATED" },
      ]),
    };
  if (args[1] === "service-account" && args[2] === "create")
    return { code: 0, stdout: "ops_fake_token\n" };
  return undefined;
};

function memoryStore(): TokenStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(id) {
      const v = data.get(id);
      return v ? (JSON.parse(JSON.stringify(v)) as never) : null;
    },
    async set(id, v) {
      data.set(id, v);
    },
    async delete(id) {
      data.delete(id);
    },
  };
}

describe("onePasswordStatus", () => {
  it("explains how to connect when the CLI isn't integrated with the app", async () => {
    const { run } = fakeRun((a) =>
      a.join(" ") === "op --version"
        ? { code: 0 }
        : a.join(" ") === "op account list --format json"
          ? { code: 0, stdout: "[]" }
          : undefined,
    );
    expect(await onePasswordStatus(run)).toMatchObject({ state: "not_connected" });
  });

  it("lists vaults, marking the built-in personal one unshareable", async () => {
    const status = await onePasswordStatus(fakeRun(connected).run);
    expect(status.state).toBe("connected");
    expect(status.account).toBe("astrid@infrawrench.com on my.1password.com");
    expect(status.vaults).toEqual([
      { id: "v1", name: "Private", shareable: false },
      { id: "v2", name: "Nibblets", shareable: true },
      { id: "v3", name: "Banking", shareable: true },
    ]);
  });

  it("reports a missing CLI", async () => {
    expect((await onePasswordStatus(fakeRun(() => undefined).run)).state).toBe("not_installed");
  });
});

describe("OnePasswordGrantsManager", () => {
  it("creates a scoped service account once, reusing it while nothing changes", async () => {
    const { run, calls } = fakeRun(connected);
    const store = memoryStore();
    const manager = new OnePasswordGrantsManager(run, store, () => 0);
    await manager.grant("nib_1", "Pip", [
      { vaultId: "v2", access: "read" },
      { vaultId: "v3", access: "write" },
    ]);
    const creates = () => calls.filter((c) => c[2] === "create");
    expect(creates()).toHaveLength(1);
    expect(creates()[0]).toEqual(
      expect.arrayContaining([
        "--vault",
        "Nibblets:read_items",
        "--vault",
        "Banking:read_items,write_items",
      ]),
    );
    await manager.grant("nib_1", "Pip", [
      { vaultId: "v3", access: "write" },
      { vaultId: "v2", access: "read" },
    ]);
    expect(creates()).toHaveLength(1);
    expect(await manager.token("nib_1")).toEqual({
      token: "ops_fake_token",
      vaults: [
        { name: "Nibblets", access: "read" },
        { name: "Banking", access: "write" },
      ],
    });
  });

  it("rotates when the vaults change, and forgets when none are left", async () => {
    const { run, calls } = fakeRun(connected);
    const store = memoryStore();
    const manager = new OnePasswordGrantsManager(run, store, () => 0);
    await manager.grant("nib_1", "Pip", [{ vaultId: "v2", access: "read" }]);
    await manager.grant("nib_1", "Pip", [{ vaultId: "v3", access: "read" }]);
    expect(calls.filter((c) => c[2] === "create")).toHaveLength(2);
    await manager.grant("nib_1", "Pip", []);
    expect(await manager.token("nib_1")).toBeNull();
  });

  it("renews an account that's about to expire", async () => {
    let now = 0;
    const { run, calls } = fakeRun(connected);
    const manager = new OnePasswordGrantsManager(run, memoryStore(), () => now);
    await manager.grant("nib_1", "Pip", [{ vaultId: "v2", access: "read" }]);
    now = 27 * 86_400_000;
    await manager.token("nib_1");
    expect(calls.filter((c) => c[2] === "create")).toHaveLength(2);
  });

  it("refuses the personal vault and unknown vaults", async () => {
    const manager = new OnePasswordGrantsManager(fakeRun(connected).run, memoryStore(), () => 0);
    await expect(manager.grant("n", "Pip", [{ vaultId: "v1", access: "read" }])).rejects.toThrow(
      "can't be shared",
    );
    await expect(manager.grant("n", "Pip", [{ vaultId: "zz", access: "read" }])).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("builds vault flags and stable fingerprints", () => {
    expect(vaultFlags([{ name: "A", access: "write" }])).toEqual([
      "--vault",
      "A:read_items,write_items",
    ]);
    expect(() => vaultFlags([{ name: "a:b", access: "read" }])).toThrow();
    expect(
      fingerprint([
        { name: "A", access: "read" },
        { name: "B", access: "write" },
      ]),
    ).toBe(
      fingerprint([
        { name: "B", access: "write" },
        { name: "A", access: "read" },
      ]),
    );
  });
});
