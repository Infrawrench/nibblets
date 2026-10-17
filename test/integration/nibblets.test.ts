import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { harnesses, type MachineChoice, type Nibblet, type StoredItem } from "@nibblet/protocol";
import { REPLY } from "./fake-anthropic.ts";
import { TestStack } from "./stack.ts";

/**
 * Nibblets through the server, on a real machine of each kind: a real
 * stack (stack.ts), the real Claude Code harness against a fake model, and
 * whichever backend NIBBLET_TEST_MACHINE names:
 *
 *   docker   containers on the engine DOCKER_HOST names (Docker or Podman)
 *   apple    Linux VMs with Apple Virtualization (a Mac)
 *   kvm      Linux VMs with KVM (Linux with /dev/kvm)
 *   hyperv   Linux VMs with Hyper-V (Windows, as a Hyper-V administrator)
 *
 * Skipped without it. The images come from NIBBLET_TEST_SERVER_IMAGE and
 * NIBBLET_TEST_RUNNER_IMAGE (nibblet/server:dev and nibblet/runner:dev, as
 * docker/up.sh builds them). See README.md here.
 */

const run = promisify(execFile);
const backend = process.env.NIBBLET_TEST_MACHINE ?? "";
const machine: MachineChoice = { backend, guest: "linux" };
const vm = backend !== "docker";
/** A VM's first start makes its image from the runner image: minutes. */
const FIRST_START_MS = vm ? 30 * 60_000 : 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!backend)(`nibblets in ${backend || "nothing"} machines`, () => {
  const stack = new TestStack({
    serverImage: process.env.NIBBLET_TEST_SERVER_IMAGE ?? "nibblet/server:dev",
    runnerImage: process.env.NIBBLET_TEST_RUNNER_IMAGE ?? "nibblet/runner:dev",
    bridge: vm,
    dockerSocket: process.env.NIBBLET_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock",
    log: process.env.NIBBLET_TEST_VERBOSE ? (line) => console.log(line) : undefined,
  });
  /** A runner of another stack's, which this one's server must leave alone. */
  const decoy = `nibblet-it-decoy-${Date.now().toString(36)}`;
  let nibblet: Nibblet;

  /** The thread so far. */
  const items = async (id: string): Promise<StoredItem[]> =>
    stack.client.thread.items({ nibbletId: id, sinceSeq: 0 });

  /** Waits for the fake model's reply to arrive as a finished turn, `count` of them. */
  const replied = async (id: string, count: number, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const thread = await items(id);
      const replies = thread.filter(
        (s) => s.item.type === "assistant_message" && s.item.text.includes(REPLY),
      );
      const finished = thread.filter(
        (s) => s.item.type === "turn" && s.item.status === "completed",
      );
      if (replies.length >= count && finished.length >= count) return;
      const failed = thread.find((s) => s.item.type === "turn" && s.item.status === "failed");
      if (failed || Date.now() > until) {
        const now = await stack.client.nibblets.get({ id });
        throw new Error(
          `No reply (${now.status}: ${now.statusDetail ?? ""}):\n${JSON.stringify(thread.map((s) => s.item)).slice(-3000)}\n${await stack.logs()}`,
        );
      }
      await sleep(2000);
    }
  };

  const status = async (id: string, want: Nibblet["status"], timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const now = await stack.client.nibblets.get({ id });
      if (now.status === want) return now;
      if (Date.now() > until) throw new Error(`Still ${now.status}: ${now.statusDetail ?? ""}`);
      await sleep(1000);
    }
  };

  beforeAll(async () => {
    if (!vm) {
      await run("docker", [
        "run",
        "-d",
        "--name",
        decoy,
        "--label",
        "nibblet.managed=true",
        "--label",
        "nibblet.role=runner",
        "--label",
        "nibblet.stack=someone-else",
        "--label",
        "nibblet.id=nib_decoy",
        "docker.io/pgvector/pgvector:0.8.7-pg18",
        "sleep",
        "600",
      ]);
    }
    await stack.up();
  }, 20 * 60_000);

  afterAll(async () => {
    await stack.down();
    if (!vm) await run("docker", ["rm", "-f", decoy]).catch(() => undefined);
  }, 10 * 60_000);

  it("offers the machine it's to run in", async () => {
    const backends = await stack.client.machines.list({});
    const found = backends.find((b) => b.id === backend);
    expect(found?.available, found?.detail ?? "not offered").toBe(true);
    expect(found?.guests.map((g) => g.os)).toContain("linux");
  });

  it(
    "answers a message through its harness",
    async () => {
      nibblet = await stack.client.nibblets.create({
        name: "Integration",
        harness: "claude",
        model: harnesses.claude.defaultModel,
        effort: "low",
        machine,
        browser: true,
        message: "Say pong.",
      });
      expect(nibblet.machine).toEqual(machine);
      await replied(nibblet.id, 1, FIRST_START_MS);
      expect(await stack.modelCalls()).toBeGreaterThan(0);
    },
    FIRST_START_MS + 60_000,
  );

  it("leaves another stack's nibblets alone", async () => {
    if (vm) return;
    const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", decoy]);
    expect(stdout.trim()).toBe("true");
  });

  it("shows its browser", async () => {
    const until = Date.now() + 120_000;
    let last = 0;
    while (Date.now() < until) {
      const res = await fetch(`${stack.base}/api/nibblets/${nibblet.id}/computer/sessions`, {
        headers: { authorization: `Bearer ${stack.ownerToken}` },
      });
      last = res.status;
      if (res.ok) {
        const body = z.object({ sessions: z.array(z.object({})) }).safeParse(await res.json());
        expect(body.success).toBe(true);
        return;
      }
      await sleep(2000);
    }
    throw new Error(`The browser's view answered ${last}`);
  }, 150_000);

  it(
    "snapshots its home, and goes back to it",
    async () => {
      const snapshot = await stack.client.snapshots.create({ nibbletId: nibblet.id, label: "it" });
      const timeline = await stack.client.snapshots.list({ nibbletId: nibblet.id });
      expect(timeline.snapshots.map((s) => s.id)).toContain(snapshot.id);
      await stack.client.snapshots.restore({ id: snapshot.id });
      await stack.client.nibblets.send({
        id: nibblet.id,
        text: "Say pong again.",
        attachments: [],
      });
      await replied(nibblet.id, 2, 10 * 60_000);
    },
    15 * 60_000,
  );

  it(
    "sleeps, and wakes for a message",
    async () => {
      await stack.client.nibblets.stop({ id: nibblet.id });
      await status(nibblet.id, "stopped", 120_000);
      const before = (await items(nibblet.id)).filter((s) => s.item.type === "turn").length;
      await stack.client.nibblets.send({
        id: nibblet.id,
        text: "Wake up and say pong.",
        attachments: [],
      });
      await replied(nibblet.id, before + 1, 10 * 60_000);
    },
    15 * 60_000,
  );

  it(
    "runs a sub-agent in its machine, which reports back",
    async () => {
      // The fake model has the nibblet call its own spawn_subagent tool.
      await stack.client.nibblets.send({
        id: nibblet.id,
        text: "SPAWN: Say pong.",
        attachments: [],
      });
      const until = Date.now() + 10 * 60_000;
      for (;;) {
        const thread = await items(nibblet.id);
        const sub = thread.find((s) => s.item.type === "subagent");
        if (sub?.item.type === "subagent" && sub.item.status === "done") {
          expect(sub.item.result).toContain(REPLY);
          const child = await stack.client.nibblets.get({ id: sub.item.childId });
          expect(child.parentId).toBe(nibblet.id);
          expect(child.machine).toEqual(machine);
          // It ran beside its parent: no machine of its own.
          if (!vm) expect((await stack.containers()).some((c) => c.includes(child.id))).toBe(false);
          return;
        }
        if (sub?.item.type === "subagent" && sub.item.status === "error") {
          throw new Error(`The sub-agent failed: ${sub.item.result ?? ""}\n${await stack.logs()}`);
        }
        if (Date.now() > until)
          throw new Error(`No sub-agent reported back\n${await stack.logs()}`);
        await sleep(2000);
      }
    },
    12 * 60_000,
  );

  it(
    "leaves nothing behind when it's deleted",
    async () => {
      await stack.client.nibblets.delete({ id: nibblet.id });
      expect(
        (await stack.client.nibblets.list({})).find((n) => n.id === nibblet.id),
      ).toBeUndefined();
      if (!vm) expect((await stack.containers()).filter((c) => c.includes(nibblet.id))).toEqual([]);
    },
    5 * 60_000,
  );
});
