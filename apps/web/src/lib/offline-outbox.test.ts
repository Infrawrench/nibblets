import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { OfflineVault } from "./offline-vault.ts";
import { drainHead } from "./offline-outbox.ts";
import {
  canRecall,
  emptyOfflinePayload,
  enqueueMessage,
  saveConversation,
  type OfflinePayload,
  type OutgoingMessage,
} from "./offline-data.ts";
import { createMockServer } from "./mock.ts";
import { RpcError } from "@nibblet/protocol";
import { createConnection } from "./connection.ts";

let vault: OfflineVault;
const message = (id: string): OutgoingMessage => ({
  id,
  server: "local",
  conversation: "chat",
  text: `private ${id}`,
  attachments: [],
  createdAt: "2026-10-18",
  state: "queued",
  attempted: false,
});
beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("location", { origin: "https://offline.example" });
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(key: string, callback: () => Promise<T>) => {
        const operation = (locks.get(key) ?? Promise.resolve()).then(callback, callback);
        locks.set(
          key,
          operation.catch(() => undefined),
        );
        return operation;
      },
    },
  });
  vault = await OfflineVault.open("outbox-tests");
  await vault.create("test recovery passphrase");
});
afterEach(() => {
  vault.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mutate = (fn: (data: OfflinePayload) => OfflinePayload) =>
  vault.update<OfflinePayload>("payload", (data) => fn(data ?? emptyOfflinePayload()));
async function host() {
  const connection = createMockServer();
  connection.pinClient = (guard) => {
    guard();
    return connection.client;
  };
  const sample = (await connection.client.nibblets.list({}))[0]!;
  vi.spyOn(connection.client.nibblets, "list").mockResolvedValue([
    { ...sample, id: "chat", status: "idle", awaitingApproval: false },
  ]);
  vi.spyOn(connection.client.system, "info").mockResolvedValue({
    serverId: "host",
    name: "host",
    version: "1",
    credentials: [],
    host: null,
    capabilities: { durableSendV1: true },
  });
  await mutate((data) => ({
    ...data,
    bindings: { local: "host" },
    outbox: [message("first"), message("second")],
  }));
  return connection;
}
describe("durable encrypted outbox", () => {
  it("pins verification and sending to one endpoint across an encrypted mutation", async () => {
    const fixture = await host();
    const info = await fixture.client.system.info({});
    const nibblets = await fixture.client.nibblets.list({});
    let route = "https://host-a.example";
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("system.info")) return Response.json({ ok: true, data: info });
      if (url.endsWith("nibblets.list")) return Response.json({ ok: true, data: nibblets });
      if (url.endsWith("/api/ticket")) return Response.json({ ticket: "test-ticket" });
      throw new Error("Unexpected send to " + url);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const connection = createConnection(
      "local",
      () => route,
      () => "test-token",
    );
    await expect(
      drainHead(
        vault,
        connection,
        "chat",
        false,
        () => true,
        async (fn) => {
          const data = await mutate(fn);
          route = "https://host-b.example";
          return data;
        },
      ),
    ).rejects.toThrow("route changed");
    expect(
      fetchSpy.mock.calls.every((call) => String(call[0]).startsWith("https://host-a.example")),
    ).toBe(true);
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("nibblets.send"))).toBe(
      false,
    );
    connection.live.close();
  });
  it("rejects route changes during asynchronous authorization before transmitting", async () => {
    let route = "https://host-a.example";
    let authorize!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      authorize = resolve;
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const connection = createConnection(
      "local",
      () => route,
      () => token,
    );
    const pinned = connection.pinClient(() => undefined);
    const sending = pinned.nibblets.send({ id: "chat", text: "private body" });
    route = "https://host-b.example";
    authorize("private-token");
    await expect(sending).rejects.toThrow("route changed");
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("nibblets.send"))).toBe(
      false,
    );
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]).startsWith("https://host-b.example")),
    ).toBe(false);
    connection.live.close();
  });
  it("retries snapshot restore unavailability with the original client ID", async () => {
    const connection = await host();
    const send = vi
      .spyOn(connection.client.nibblets, "send")
      .mockRejectedValueOnce(new RpcError("unavailable", "A snapshot is being restored"));
    await drainHead(vault, connection, "chat", false, () => true, mutate);
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
      id: "first",
      state: "uncertain",
      retrySafe: true,
    });
    send.mockResolvedValue({
      ok: true,
      receipt: { clientMessageId: "first", turnId: "turn", state: "started" },
    });
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect(send.mock.calls.map((call) => call[0].clientMessageId)).toEqual(["first", "first"]);
  });
  it("checks the lock at the fetch boundary after asynchronous authorization", async () => {
    let authorize!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      authorize = resolve;
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const connection = createConnection(
      "local",
      () => "https://host.example",
      () => token,
    );
    const pinned = connection.pinClient(() => {
      if (!vault.unlocked) throw new Error("locked");
    });
    const sending = pinned.nibblets.send({ id: "chat", text: "never transmit after lock" });
    vault.lock();
    authorize("test-token");
    await expect(sending).rejects.toThrow("locked");
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("nibblets.send"))).toBe(
      false,
    );
    connection.live.close();
  });
  it("retains ambiguous server errors and pauses authorization errors at the FIFO head", async () => {
    const connection = await host();
    const send = vi
      .spyOn(connection.client.nibblets, "send")
      .mockRejectedValue(new RpcError("internal", "Accepted but dispatch failed"));
    await drainHead(vault, connection, "chat", false, () => true, mutate);
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
      state: "uncertain",
      retrySafe: true,
    });
    send.mockRejectedValue(new RpcError("unauthorized", "Sign in again"));
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
      id: "first",
      state: "uncertain",
      retrySafe: false,
    });
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("preserves reconnect eligibility while busy until an actual retry starts", async () => {
    const connection = await host();
    await mutate((data) => ({
      ...data,
      outbox: [{ ...message("first"), state: "uncertain", attempted: true, retrySafe: true }],
    }));
    const nibblet = (await connection.client.nibblets.list({}))[0]!;
    vi.mocked(connection.client.nibblets.list).mockResolvedValue([
      { ...nibblet, status: "working" },
    ]);
    const attempted = vi.fn();
    const send = vi.spyOn(connection.client.nibblets, "send").mockResolvedValue({
      ok: true,
      receipt: { clientMessageId: "first", turnId: "turn", state: "finished" },
    });
    await drainHead(vault, connection, "chat", true, () => true, mutate, attempted);
    expect(attempted).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    vi.mocked(connection.client.nibblets.list).mockResolvedValue([nibblet]);
    await drainHead(vault, connection, "chat", true, () => true, mutate, attempted);
    expect(attempted).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].clientMessageId).toBe("first");
  });
  it("sends only one FIFO head and persists its attempted state before calling the host", async () => {
    const connection = await host();
    const send = vi.spyOn(connection.client.nibblets, "send").mockImplementation(async (input) => {
      expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
        id: "first",
        attempted: true,
        state: "uncertain",
      });
      return {
        ok: true,
        receipt: { clientMessageId: input.clientMessageId!, turnId: "turn", state: "queued" },
      };
    });
    expect(await drainHead(vault, connection, "chat", false, () => true, mutate)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await vault.read<OfflinePayload>("payload"))?.outbox.map((m) => m.state)).toEqual([
      "accepted",
      "queued",
    ]);
  });
  it("replays a lost acknowledgement with the original ID only on reconnect", async () => {
    const connection = await host();
    const send = vi
      .spyOn(connection.client.nibblets, "send")
      .mockRejectedValueOnce(new TypeError("network"));
    await expect(drainHead(vault, connection, "chat", false, () => true, mutate)).rejects.toThrow(
      "network",
    );
    await drainHead(vault, connection, "chat", false, () => true, mutate);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue({
      ok: true,
      receipt: { clientMessageId: "first", turnId: "turn", state: "started" },
    });
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect(send.mock.calls.map((call) => call[0].clientMessageId)).toEqual(["first", "first"]);
  });
  it("pauses unsupported hosts and host substitutions without attempting a send", async () => {
    const connection = await host();
    const send = vi.spyOn(connection.client.nibblets, "send");
    const info = await connection.client.system.info({});
    vi.mocked(connection.client.system.info).mockResolvedValue({
      ...info,
      capabilities: undefined,
    });
    await expect(drainHead(vault, connection, "chat", true, () => true, mutate)).rejects.toThrow(
      "Update",
    );
    vi.mocked(connection.client.system.info).mockResolvedValue({
      ...info,
      serverId: "another-host",
    });
    await expect(drainHead(vault, connection, "chat", true, () => true, mutate)).rejects.toThrow(
      "identity",
    );
    expect(send).not.toHaveBeenCalled();
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]?.attempted).toBe(false);
  });
  it("never retries a missing receipt and exposes interrupted submissions without resending", async () => {
    const connection = await host();
    const send = vi.spyOn(connection.client.nibblets, "send").mockResolvedValue({ ok: true });
    await drainHead(vault, connection, "chat", false, () => true, mutate);
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect(send).toHaveBeenCalledTimes(1);
    await mutate((data) => ({ ...data, outbox: [message("terminal")] }));
    send.mockResolvedValue({
      ok: true,
      receipt: { clientMessageId: "terminal", turnId: "turn", state: "interrupted" },
    });
    await drainHead(vault, connection, "chat", true, () => true, mutate);
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
      state: "rejected",
      detail: "interrupted",
    });
  });
  it("serializes two tabs and waits for the thread edit lock", async () => {
    const connection = await host();
    const send = vi.spyOn(connection.client.nibblets, "send").mockResolvedValue({
      ok: true,
      receipt: { clientMessageId: "first", turnId: "turn", state: "started" },
    });
    let release!: () => void;
    const editing = navigator.locks.request(
      `nibblets-outbox:${vault.id}:${JSON.stringify(["local", "chat"])}`,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const draining = drainHead(vault, connection, "chat", false, () => true, mutate);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    release();
    await editing;
    await draining;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("drops late receipts after lock and preserves the encrypted uncertain state", async () => {
    const connection = await host();
    vi.spyOn(connection.client.nibblets, "send").mockImplementation(async () => {
      vault.lock();
      return { ok: true, receipt: { clientMessageId: "first", turnId: "turn", state: "started" } };
    });
    await drainHead(vault, connection, "chat", false, () => true, mutate);
    await vault.unlock("test recovery passphrase");
    expect((await vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("uncertain");
  });
  it("bounds the outbox independently from sanitized history", async () => {
    let data = emptyOfflinePayload();
    for (let i = 0; i < 5; i++) data = enqueueMessage(data, message(String(i)));
    expect(() => enqueueMessage(data, message("six"))).toThrow("Five");
    expect(() =>
      enqueueMessage(
        { ...data, outbox: data.outbox.map((m) => ({ ...m, state: "rejected" })) },
        message("six"),
      ),
    ).toThrow("Five");
    expect(() =>
      enqueueMessage(emptyOfflinePayload(), { ...message("large"), text: "x".repeat(128 * 1024) }),
    ).toThrow("128");
    const connection = await host();
    const nibblet = (await connection.client.nibblets.list({}))[0]!;
    const saved = saveConversation(
      data,
      "local",
      "host",
      "host",
      { ...nibblet, instructions: "secret config" },
      [],
    );
    expect(saved.outbox).toEqual(data.outbox);
    expect(JSON.stringify(saved.conversations)).not.toContain("secret config");
  });
  it("preserves older history and outgoing messages when one new conversation exceeds the history budget", async () => {
    const connection = await host();
    const nibblet = (await connection.client.nibblets.list({}))[0]!;
    const payload = saveConversation(
      { ...emptyOfflinePayload(), outbox: [message("waiting")] },
      "local",
      "host",
      "host",
      nibblet,
      [],
    );
    const oversized = saveConversation(
      payload,
      "local",
      "host",
      "host",
      { ...nibblet, id: "oversized" },
      [
        {
          nibbletId: "oversized",
          seq: 1,
          item: {
            id: "huge",
            turnId: null,
            createdAt: "2026-10-18T00:00:00.000Z",
            type: "assistant_message",
            text: "x".repeat(10 * 1024 * 1024),
            streaming: false,
          },
        },
      ],
    );
    expect(oversized).toEqual(payload);
    const replacing = saveConversation(payload, "local", "host", "host", nibblet, [
      {
        nibbletId: nibblet.id,
        seq: 1,
        item: {
          id: "huge",
          turnId: null,
          createdAt: "2026-10-18T00:00:00.000Z",
          type: "assistant_message",
          text: "x".repeat(10 * 1024 * 1024),
          streaming: false,
        },
      },
    ]);
    expect(replacing.conversations[0]?.savedAt).toBe(payload.conversations[0]?.savedAt);
    expect(replacing.outbox).toEqual(payload.outbox);
  });
});
describe("Up recall eligibility", () => {
  const event = {
    key: "ArrowUp",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    composing: false,
  };
  const area = {
    value: "draft",
    selectionStart: 2,
    selectionEnd: 2,
    scrollTop: 0,
    clientWidth: 200,
  };
  it("requires a collapsed caret on the first visual line without IME or modifiers", () => {
    expect(canRecall(event, area, true)).toBe(true);
    expect(canRecall(event, area, false)).toBe(false);
    expect(canRecall({ ...event, composing: true }, area, true)).toBe(false);
    expect(canRecall({ ...event, shiftKey: true }, area, true)).toBe(false);
    expect(canRecall(event, { ...area, selectionEnd: 3 }, true)).toBe(false);
    expect(
      canRecall(
        event,
        { ...area, value: "first\nsecond", selectionStart: 7, selectionEnd: 7 },
        true,
      ),
    ).toBe(false);
  });
});
