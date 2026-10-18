import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GUEST_NAMES,
  GuestOs,
  harnesses,
  type MachineCapabilities,
  type MachineChoice,
  type Nibblet,
  type StoredItem,
} from "@nibblet/protocol";
import { REPLY } from "./fake-anthropic.ts";
import { TestStack } from "./stack.ts";

/**
 * Nibblets through the server, on a real machine of each kind: a real
 * stack (stack.ts), the real Claude Code harness against a fake model, and
 * whichever backend NIBBLET_TEST_MACHINE names:
 *
 *   docker   containers on the engine DOCKER_HOST names (Docker or Podman)
 *   apple    VMs with Apple Virtualization (a Mac)
 *   kvm      VMs with KVM (Linux with /dev/kvm)
 *   hyperv   VMs with Hyper-V (Windows, as a Hyper-V administrator)
 *
 * running the guest NIBBLET_TEST_GUEST names: linux (the default), windows
 * (Hyper-V and KVM, from the ISO NIBBLET_TEST_WINDOWS_ISO names) or macos
 * (Apple's). Windows' and macOS's images are installed first, and install
 * the runner from GitHub at this commit, so it has to be pushed.
 *
 * Skipped without a machine. The images come from NIBBLET_TEST_SERVER_IMAGE
 * and NIBBLET_TEST_RUNNER_IMAGE (nibblet/server:dev and nibblet/runner:dev,
 * as docker/up.sh builds them). See README.md here.
 */

const run = promisify(execFile);
const backend = process.env.NIBBLET_TEST_MACHINE ?? "";
const guest = GuestOs.parse(process.env.NIBBLET_TEST_GUEST ?? "linux");
const machine: MachineChoice = { backend, guest };
const vm = backend !== "docker";
const windowsIso = process.env.NIBBLET_TEST_WINDOWS_ISO ?? "";
const repo = process.env.NIBBLET_TEST_GUEST_REPO ?? "Infrawrench/nibblets";
/** What stops it running here, if anything. */
const missing = !backend
  ? "NIBBLET_TEST_MACHINE"
  : guest === "windows" && !windowsIso
    ? "NIBBLET_TEST_WINDOWS_ISO"
    : null;
/** A Linux VM's first start makes its image from the runner image: minutes. */
const FIRST_START_MS = vm ? 30 * 60_000 : 5 * 60_000;
/**
 * Installing Windows from its ISO, or macOS from Apple's restore image, then
 * Node and the runner: half an hour or so with a hypervisor's acceleration,
 * so longer means it's stuck (the hypervisor's own limit is longer).
 */
const INSTALL_MS = 90 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What Windows and macOS guests install the runner from: this commit, unless told another. */
async function guestRef(): Promise<string> {
  const ref =
    process.env.NIBBLET_TEST_GUEST_REF ?? (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const res = await fetch(`https://github.com/${repo}/archive/${ref}.tar.gz`, { method: "HEAD" });
  if (!res.ok) {
    throw new Error(
      `GitHub doesn't have ${ref} of ${repo} (${res.status}), which the guest installs: push it, or set NIBBLET_TEST_GUEST_REF`,
    );
  }
  return ref;
}

const title = missing
  ? `nibblets in machines (needs ${missing})`
  : `${GUEST_NAMES[guest]} nibblets in ${backend} machines`;

describe.skipIf(missing !== null)(title, () => {
  const stack = new TestStack({
    serverImage: process.env.NIBBLET_TEST_SERVER_IMAGE ?? "nibblet/server:dev",
    runnerImage: process.env.NIBBLET_TEST_RUNNER_IMAGE ?? "nibblet/runner:dev",
    bridge: vm,
    dockerSocket: process.env.NIBBLET_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock",
    ...(process.env.NIBBLET_TEST_MACHINES_DIR
      ? { machinesDir: process.env.NIBBLET_TEST_MACHINES_DIR }
      : {}),
    log: process.env.NIBBLET_TEST_VERBOSE ? (line) => console.log(line) : undefined,
  });
  /** A runner of another stack's, which this one's server must leave alone. */
  const decoy = `nibblet-it-decoy-${Date.now().toString(36)}`;
  let nibblet: Nibblet;
  /** What its guest can do, as the server says. */
  let capabilities: MachineCapabilities | undefined;

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
      const now = await stack.client.nibblets.get({ id });
      if (failed || now.status === "error" || Date.now() > until) {
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
    await stack.up(guest === "linux" ? {} : { guestRef: await guestRef(), repo });
  }, 20 * 60_000);

  afterAll(async () => {
    await stack.down();
    if (!vm) await run("docker", ["rm", "-f", decoy]).catch(() => undefined);
  }, 10 * 60_000);

  it("offers the machine it's to run in", async () => {
    const backends = await stack.client.machines.list({});
    const found = backends.find((b) => b.id === backend);
    expect(found?.available, found?.detail ?? "not offered").toBe(true);
    const offered = found?.guests.find((g) => g.os === guest);
    expect(offered, `${GUEST_NAMES[guest]} isn't offered`).toBeDefined();
    capabilities = offered?.capabilities;
  });

  it.skipIf(guest === "linux")(
    `installs ${GUEST_NAMES[guest]} for its machines`,
    async () => {
      if (guest === "macos") {
        console.log("macOS's image needs an administrator's password: a window here will ask.");
      }
      await stack.client.machines.prepare({
        backend,
        guest,
        ...(guest === "windows" ? { source: windowsIso } : {}),
      });
      const until = Date.now() + INSTALL_MS;
      let said = "";
      for (;;) {
        const backends = await stack.client.machines.list({});
        const image = backends
          .find((b) => b.id === backend)
          ?.guests.find((g) => g.os === guest)?.image;
        if (image?.state === "ready") return;
        if (image?.state === "error" || Date.now() > until) {
          throw new Error(
            `Its image is ${image?.state ?? "gone"}: ${image?.detail ?? ""}\n${await stack.logs()}`,
          );
        }
        const pct = image?.progress == null ? "" : ` (${Math.round(image.progress * 100)}%)`;
        const now = `${image?.detail ?? image?.state ?? ""}${pct}`;
        if (now !== said) console.log(`${GUEST_NAMES[guest]} image: ${now}`);
        said = now;
        await sleep(10_000);
      }
    },
    INSTALL_MS + 60_000,
  );

  it(
    "answers a message through its harness",
    async () => {
      nibblet = await stack.client.nibblets.create({
        name: "Integration",
        harness: "claude",
        model: harnesses.claude.defaultModel,
        effort: "low",
        machine,
        browser: capabilities?.browser ?? false,
        message: "Say pong.",
      });
      expect(nibblet.machine).toEqual(machine);
      await replied(nibblet.id, 1, FIRST_START_MS);
      expect((await stack.modelCalls()).length).toBeGreaterThan(0);
    },
    FIRST_START_MS + 60_000,
  );

  it("leaves another stack's nibblets alone", async () => {
    if (vm) return;
    const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", decoy]);
    expect(stdout.trim()).toBe("true");
  });

  it("shows its browser, if its guest has one", async ({ skip }) => {
    if (!capabilities?.browser) skip();
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
        if (Date.now() > until) {
          const calls = (await stack.modelCalls()).map(
            (c) =>
              `${c.answer} <- ${c.last.slice(0, 120)} (${c.tools.filter((t) => t.includes("nibblet")).join(", ")})`,
          );
          throw new Error(
            `No sub-agent reported back.\nThe model's calls:\n${calls.join("\n")}\nThe thread:\n${JSON.stringify(thread.map((s) => s.item)).slice(-3000)}\n${await stack.logs()}`,
          );
        }
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
      // Its VM goes with it, disks and all, a moment after.
      const until = Date.now() + 120_000;
      while (vm && (await stack.vms(backend)).includes(nibblet.id)) {
        if (Date.now() > until) throw new Error(`Its VM is still on the host`);
        await sleep(2000);
      }
    },
    5 * 60_000,
  );
});
