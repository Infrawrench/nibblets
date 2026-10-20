import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, ServerToGuest } from "@nibblet/protocol";
import { GuestLink, type GuestSocket } from "../src/guest-link.ts";

/** A socket to a pretend guest: what the link sends is kept; `say` is the guest talking. */
function pretend() {
  const sent: ServerToGuest[] = [];
  let onMessage: (data: string | Uint8Array) => void = () => {};
  const socket: GuestSocket = {
    send: (data) => {
      if (typeof data === "string") sent.push(ServerToGuest.parse(JSON.parse(data)));
    },
    close: () => {},
    bufferedAmount: 0,
    onMessage: (handler) => (onMessage = handler),
    onClose: () => {},
  };
  const say = (msg: object) => onMessage(JSON.stringify(msg));
  const hello = (runs: string[] = [], exited: object[] = [], also: object = {}) =>
    say({
      type: "hello",
      os: "linux",
      version: "t",
      runs: runs.map((run) => ({ run, pid: 1 })),
      exited,
      ...also,
    });
  return {
    socket,
    sent,
    say,
    hello,
    data: (channel: number, bytes: number[]) =>
      onMessage(encodeFrame(channel, new Uint8Array(bytes))),
  };
}

const settles = (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);

describe("a guest link", () => {
  it("doesn't take an old exit for a run that's running again", async () => {
    const guest = pretend();
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    // A sub-agent that stopped, and was started again in the same boot.
    guest.hello(["subagent:x"], [{ run: "subagent:x", code: 1, signal: null, error: null }]);
    const link = await opening;
    expect(link.isRunning("subagent:x")).toBe(true);
    expect(await settles(link.exited("subagent:x"))).toBe(false);
  });

  it("fails a job whose output the port lost, rather than calling it done", async () => {
    const guest = pretend();
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    guest.hello();
    const link = await opening;
    const got: number[] = [];
    const out = new Writable({
      write(chunk: Buffer, _enc, done) {
        got.push(...chunk);
        done();
      },
    });
    out.on("error", () => {});
    const job = link.runToEnd({ command: "archive-home", stdout: out });
    await new Promise((r) => setTimeout(r, 10));
    const run = guest.sent.find((m) => m.type === "run");
    if (run?.type !== "run" || run.stdout === null) throw new Error("no run");
    guest.say({ type: "started", run: run.run, pid: 2 });
    guest.data(run.stdout, [1, 2, 3]);
    // The port starts afresh (the bridge restarted): the rest of the archive is gone.
    guest.hello([run.run]);
    guest.say({ type: "exited", run: run.run, code: 0, signal: null, error: null });
    await expect(job).rejects.toThrow(/cut off/);
    expect(got).toEqual([1, 2, 3]);
  });

  /** A link that's started a job, its run, and the job's end. */
  async function started(guest: ReturnType<typeof pretend>) {
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    const asked = guest.sent.find((m) => m.type === "hello");
    const link = asked?.type === "hello" ? asked.link : undefined;
    guest.hello([], [], { link, epoch: "agent.1" });
    const opened = await opening;
    const out = new Writable({ write: (_c, _e, done) => done() });
    out.on("error", () => {});
    const job = opened.runToEnd({ command: "archive-home", stdout: out });
    job.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    const run = guest.sent.find((m) => m.type === "run");
    if (run?.type !== "run") throw new Error("no run");
    guest.say({ type: "started", run: run.run, pid: 2 });
    return { link, run: run.run, job };
  }

  it("loses nothing to the guest answering its hello twice", async () => {
    const guest = pretend();
    const { link, run, job } = await started(guest);
    // Asked by the link and by the bridge: the same agent, having let go of nothing.
    guest.hello([], [], { link, epoch: "agent.1" });
    guest.say({ type: "exited", run, code: 0, signal: null, error: null });
    await expect(job).resolves.toBeUndefined();
  });

  it("opens on its own answer, not on the agent saying hello as it starts", async () => {
    const guest = pretend();
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    const asked = guest.sent.find((m) => m.type === "hello");
    guest.hello([], [], { epoch: "agent.0" });
    expect(await settles(opening)).toBe(false);
    guest.hello([], [], { link: asked?.type === "hello" ? asked.link : "", epoch: "agent.2" });
    expect(await settles(opening)).toBe(true);
  });

  it("doesn't hear another link's answer", async () => {
    const guest = pretend();
    const { run, job } = await started(guest);
    guest.hello([], [], { link: "another", epoch: "agent.2" });
    guest.say({ type: "exited", run, code: 0, signal: null, error: null });
    await expect(job).resolves.toBeUndefined();
  });

  it("is cut off when the guest has let go of its channels since", async () => {
    const guest = pretend();
    const { link, run, job } = await started(guest);
    guest.hello([run], [], { link, epoch: "agent.2" });
    guest.say({ type: "exited", run, code: 0, signal: null, error: null });
    await expect(job).rejects.toThrow(/cut off/);
  });

  it("names each job its own, so a new link's first job isn't an old one's", async () => {
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const guest = pretend();
      const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
      guest.hello();
      const link = await opening;
      void link.runToEnd({ command: "stop-subagent", args: ["x"] }).catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
      const run = guest.sent.find((m) => m.type === "run");
      if (run?.type === "run") names.push(run.run);
      link.close();
    }
    expect(new Set(names).size).toBe(2);
  });

  it("kills a job that's stopped, and says what it last said", async () => {
    const guest = pretend();
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    guest.hello();
    const link = await opening;
    const stop = new AbortController();
    const job = link.runToEnd({ command: "archive-home" }, 60_000, stop.signal);
    await new Promise((r) => setTimeout(r, 10));
    const run = guest.sent.find((m) => m.type === "run");
    if (run?.type !== "run" || run.stderr === null) throw new Error("no run");
    guest.say({ type: "started", run: run.run, pid: 2 });
    guest.data(run.stderr, [...new TextEncoder().encode("a nibblet/AppData/NTUSER.DAT\n")]);
    await new Promise((r) => setTimeout(r, 10));
    stop.abort(new Error("stalled"));
    await expect(job).rejects.toThrow(/archive-home stalled: a nibblet\/AppData\/NTUSER\.DAT/);
    expect(guest.sent).toContainEqual({ type: "signal", run: run.run, signal: "SIGKILL" });
  });

  it("sends a stream of strings as their bytes, not an empty frame", async () => {
    const guest = pretend();
    const frames: Uint8Array[] = [];
    const send = guest.socket.send;
    guest.socket.send = (data) => {
      if (typeof data !== "string") frames.push(data);
      send(data);
    };
    const opening = GuestLink.open(guest.socket, { nibbletId: "n", boot: "b" });
    guest.hello();
    const link = await opening;
    void link.runToEnd({ command: "product-key", stdin: Readable.from(["ABCDE"]) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    const run = guest.sent.find((m) => m.type === "run");
    if (run?.type !== "run" || run.stdin === null) throw new Error("no run");
    // What it's given goes in once it's started.
    guest.say({ type: "started", run: run.run, pid: 2 });
    await new Promise((r) => setTimeout(r, 20));
    const sent = frames.map((f) => decodeFrame(f)).find((f) => f?.channel === run.stdin);
    expect(new TextDecoder().decode(sent?.data)).toBe("ABCDE");
  });
});
