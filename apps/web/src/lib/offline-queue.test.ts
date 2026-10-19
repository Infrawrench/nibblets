// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://offline.example"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { BroadcastChannel } from "node:worker_threads";
import { IDBFactory } from "fake-indexeddb";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RpcError, type LiveMessage } from "@nibblet/protocol";
import { OfflineVault } from "./offline-vault.ts";
import { emptyOfflinePayload, type OfflinePayload } from "./offline-data.ts";
import { createMockServer } from "./mock.ts";
import { drainHead } from "./offline-outbox.ts";
import { OfflineBridge } from "./offline-bridge.tsx";
import { useOffline } from "./offline-context.tsx";
import { useServers } from "./servers.tsx";
import { useQueuedMessages } from "../components/thread/QueuedMessages.tsx";
import { createConnection } from "./connection.ts";

const shared = vi.hoisted(() => ({
  offline: null as ReturnType<typeof useOffline> | null,
  servers: null as ReturnType<typeof useServers> | null,
}));
vi.mock("./offline-context.tsx", async (original) => ({
  ...(await original<typeof import("./offline-context.tsx")>()),
  useOffline: () => {
    if (!shared.offline) throw new Error("Missing test vault");
    return shared.offline;
  },
}));
vi.mock("./servers.tsx", async (original) => ({
  ...(await original<typeof import("./servers.tsx")>()),
  useServers: () => {
    if (!shared.servers) throw new Error("Missing test server");
    return shared.servers;
  },
}));

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("BroadcastChannel", BroadcastChannel);
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(key: string, fn: () => Promise<T>): Promise<T> => {
        const operation = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
        locks.set(
          key,
          operation.catch(() => undefined),
        );
        return operation;
      },
    },
  });
});
afterEach(() => {
  shared.offline = null;
  shared.servers = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const vault = await OfflineVault.open("mounted-queue-tests");
  await vault.create("test recovery passphrase");
  const id = crypto.randomUUID();
  const payload: OfflinePayload = {
    ...emptyOfflinePayload(),
    bindings: { local: "host" },
    outbox: [
      {
        id,
        server: "local",
        conversation: "chat",
        text: "original queued text",
        attachments: [],
        createdAt: "2026-10-18",
        state: "queued",
        attempted: false,
      },
    ],
  };
  await vault.update("payload", () => payload);
  const mutate = async (fn: (data: OfflinePayload) => OfflinePayload) => {
    const data = await vault.update<OfflinePayload>("payload", (old) =>
      fn(old ?? emptyOfflinePayload()),
    );
    if (shared.offline) shared.offline.payload = data;
    return data;
  };
  shared.offline = {
    vault,
    payload,
    mutate,
    error: null,
    report: vi.fn(),
    enqueue: async () => {
      throw new Error("Not used in edit tests");
    },
  };
  const connection = createMockServer();
  connection.pinClient = (guard) => ({
    ...connection.client,
    nibblets: {
      ...connection.client.nibblets,
      send: (input) => {
        guard();
        return connection.client.nibblets.send(input);
      },
    },
  });
  const sample = (await connection.client.nibblets.list({}))[0]!;
  const idle = { ...sample, id: "chat", status: "idle" as const, awaitingApproval: false };
  vi.spyOn(connection.client.nibblets, "list").mockResolvedValue([idle]);
  vi.spyOn(connection.client.system, "info").mockResolvedValue({
    serverId: "host",
    name: "host",
    version: "1",
    credentials: [],
    host: null,
    capabilities: { durableSendV1: true },
  });
  const send = vi.spyOn(connection.client.nibblets, "send").mockResolvedValue({
    ok: true,
    receipt: { clientMessageId: id, turnId: "turn", state: "queued" },
  });
  return { vault, id, connection, idle, mutate, send };
}

describe("mounted queued editor", () => {
  it.each([
    { exit: "unmount", fails: false },
    { exit: "cancel", fails: false },
    { exit: "unmount", fails: true },
    { exit: "cancel", fails: true },
  ])(
    "holds the edit lock until save settles after $exit (write fails: $fails)",
    async ({ exit, fails }) => {
      const f = await fixture();
      let queue!: ReturnType<typeof useQueuedMessages>;
      let setDraft!: (value: string) => void;
      function Editor() {
        const [text, setText] = useState("parked draft");
        setDraft = setText;
        queue = useQueuedMessages("local", "chat", text, setText);
        return null;
      }
      const root = createRoot(document.getElementById("root")!);
      let mounted = true;
      let unblock: () => void = () => undefined;
      try {
        await act(async () => {
          root.render(createElement(Editor));
        });
        await act(async () => {
          await queue.recall();
        });
        await act(async () => {
          setDraft("saved new text");
        });
        let entered!: () => void;
        const encrypting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          if (fails) throw new DOMException("Quota exceeded", "QuotaExceededError");
          return encrypt(...args);
        });
        let saving!: Promise<void>;
        await act(async () => {
          saving = queue.send([]);
          await encrypting;
        });
        await expect(queue.send([])).rejects.toThrow("still being saved");
        const savingResult = saving.catch((error) => error);
        await act(async () => {
          if (exit === "unmount") {
            root.unmount();
            mounted = false;
          } else queue.cancel();
        });
        const draining = drainHead(f.vault, f.connection, "chat", "queue", () => true, f.mutate);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(f.send).not.toHaveBeenCalled();
        await act(async () => {
          unblock();
          const error = await savingResult;
          if (fails) expect(error).toBeInstanceOf(DOMException);
          else expect(error).toBeUndefined();
          await draining;
        });
        expect(f.send).toHaveBeenCalledOnce();
        expect(f.send.mock.calls[0]?.[0]).toMatchObject({
          text: fails ? "original queued text" : "saved new text",
          clientMessageId: f.id,
        });
      } finally {
        unblock();
        if (mounted) await act(async () => root.unmount());
        f.vault.close();
      }
    },
  );
  it("retains a failed mounted edit lease until the user cancels", async () => {
    const f = await fixture();
    let queue!: ReturnType<typeof useQueuedMessages>;
    function Editor() {
      const [text, setText] = useState("draft");
      queue = useQueuedMessages("local", "chat", text, setText);
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => {
        root.render(createElement(Editor));
      });
      await act(async () => {
        await queue.recall();
      });
      vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(
        new DOMException("Quota exceeded", "QuotaExceededError"),
      );
      await act(async () => {
        await expect(queue.send([])).rejects.toThrow("Quota exceeded");
      });
      expect(queue.editing?.id).toBe(f.id);
      expect(queue.savingEdit).toBe(false);
      const draining = drainHead(f.vault, f.connection, "chat", "queue", () => true, f.mutate);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.send).not.toHaveBeenCalled();
      await act(async () => {
        queue.cancel();
        await draining;
      });
      expect(f.send.mock.calls[0]?.[0].text).toBe("original queued text");
    } finally {
      await act(async () => root.unmount());
      f.vault.close();
    }
  });
});

describe("mounted outbox availability", () => {
  async function mount(sendError: Error, heldResponse = false, initiallyLocked = false) {
    const f = await fixture();
    let rejectFirst!: (error: Error) => void;
    if (heldResponse)
      f.send.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );
    else f.send.mockRejectedValueOnce(sendError);
    let emit!: (message: LiveMessage) => void;
    let reconnect: () => void = () => undefined;
    f.connection.live = {
      onState: (callback) => {
        callback("open");
        return () => undefined;
      },
      onReconnect: (callback) => {
        reconnect = callback;
        return () => undefined;
      },
      subscribe: (callback) => {
        emit = callback;
        return () => undefined;
      },
      close: () => undefined,
    };
    const system = {
      id: "local",
      name: "host",
      platform: null,
      local: true,
      online: true,
      route: null,
      connection: f.connection,
    };
    shared.servers = {
      all: [f.connection],
      systems: [system],
      byId: () => f.connection,
      system: () => system,
      central: null,
    };
    if (initiallyLocked) {
      await f.mutate((data) => ({
        ...data,
        outbox: data.outbox.map((message) => ({
          ...message,
          state: "uncertain",
          attempted: true,
          retrySafe: true,
        })),
      }));
      f.vault.lock();
      shared.offline!.payload = emptyOfflinePayload();
    }
    const client = new QueryClient();
    const root = createRoot(document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge)));
    });
    if (!initiallyLocked) await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    return {
      ...f,
      rejectFirst,
      emitReconnect: async () => {
        await act(async () => {
          reconnect();
        });
      },
      render: async () => {
        await act(async () => {
          root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge)));
        });
      },
      rebind: async () => {
        shared.servers = { ...shared.servers!, systems: [...shared.servers!.systems] };
        await act(async () => {
          root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge)));
        });
      },
      unlock: async () => {
        await act(async () => {
          await f.vault.unlock("test recovery passphrase");
          shared.offline!.payload =
            (await f.vault.read<OfflinePayload>("payload")) ?? emptyOfflinePayload();
          root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge)));
        });
      },
      emitSnapshotComplete: async () => {
        await act(async () => {
          emit({ type: "snapshots_changed", nibbletId: "chat", activity: null });
        });
      },
      emitIdle: async () => {
        await act(async () => {
          emit({ type: "nibblet", nibblet: f.idle });
        });
      },
      close: async () => {
        await act(async () => root.unmount());
        client.clear();
        f.vault.close();
      },
    };
  }
  it("preserves a real reconnect while busy across a same-connection provider rebind", async () => {
    const f = await mount(new TypeError("Network receipt lost"));
    try {
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("uncertain"),
      );
      vi.mocked(f.connection.client.nibblets.list).mockResolvedValue([
        { ...f.idle, status: "working" },
      ]);
      await f.emitReconnect();
      await vi.waitFor(() => expect(f.connection.client.nibblets.list).toHaveBeenCalledTimes(2));
      await f.rebind();
      await vi.waitFor(() => expect(f.connection.client.nibblets.list).toHaveBeenCalledTimes(3));
      vi.mocked(f.connection.client.nibblets.list).mockResolvedValue([f.idle]);
      await f.emitIdle();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
      expect(f.send.mock.calls.map((call) => call[0].clientMessageId)).toEqual([f.id, f.id]);
    } finally {
      await f.close();
    }
  });
  it("preserves retry permission when a provider rebind aborts awaited send authorization", async () => {
    const f = await fixture();
    const info = await f.connection.client.system.info({});
    let entered!: () => void;
    let releaseAuth!: () => void;
    const authorizing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    let holdAuth = false;
    let firstAttempt = true;
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/ticket")) return Response.json({ ticket: "test-ticket" });
        if (url.endsWith("system.info")) return Response.json({ ok: true, data: info });
        if (url.endsWith("nibblets.list")) return Response.json({ ok: true, data: [f.idle] });
        if (url.endsWith("nibblets.send")) {
          sent.push(String(init?.body));
          return Response.json({
            ok: true,
            data: {
              ok: true,
              receipt: { clientMessageId: f.id, turnId: "turn", state: "finished" },
            },
          });
        }
        throw new Error("Unexpected test request");
      }),
    );
    vi.stubGlobal(
      "WebSocket",
      class {
        close() {}
      },
    );
    const connection = createConnection(
      "local",
      () => "https://host.example",
      async () => {
        if (holdAuth) {
          holdAuth = false;
          entered();
          await authGate;
        }
        return "test-token";
      },
    );
    connection.live.close();
    connection.live = {
      onState: (callback) => {
        callback("open");
        return () => undefined;
      },
      onReconnect: () => () => undefined,
      subscribe: () => () => undefined,
      close: () => undefined,
    };
    const system = {
      id: "local",
      name: "host",
      platform: null,
      local: true,
      online: true,
      route: null,
      connection,
    };
    shared.servers = {
      all: [connection],
      systems: [system],
      byId: () => connection,
      system: () => system,
      central: null,
    };
    shared.offline!.mutate = async (fn) => {
      const payload = await f.mutate(fn);
      if (firstAttempt && payload.outbox[0]?.attempted) {
        firstAttempt = false;
        holdAuth = true;
      }
      return payload;
    };
    const client = new QueryClient();
    const root = createRoot(document.getElementById("root")!);
    const render = () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(OfflineBridge)));
    try {
      await act(async () => {
        render();
      });
      await authorizing;
      shared.servers = { ...shared.servers, systems: [...shared.servers.systems] };
      await act(async () => {
        render();
      });
      await act(async () => {
        releaseAuth();
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(JSON.parse(sent[0]!)).toMatchObject({
        clientMessageId: f.id,
        text: "original queued text",
      });
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("accepted"),
      );
    } finally {
      releaseAuth();
      await act(async () => root.unmount());
      client.clear();
      f.vault.close();
    }
  });
  it("restores uncertain retry eligibility when the first open notification arrived while locked", async () => {
    const f = await mount(new TypeError("unused response"), false, true);
    try {
      expect(f.send).not.toHaveBeenCalled();
      f.send.mockReset().mockResolvedValue({
        ok: true,
        receipt: { clientMessageId: f.id, turnId: "turn", state: "finished" },
      });
      await f.unlock();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
      expect(f.send.mock.calls[0]?.[0].clientMessageId).toBe(f.id);
    } finally {
      await f.close();
    }
  });
  it.each([
    new RpcError("internal", "Uncertain acceptance"),
    new TypeError("Network receipt lost"),
  ])(
    "does not treat unchanged open connections as reconnects after provider rebind: %s",
    async (error) => {
      const f = await mount(error);
      try {
        await vi.waitFor(async () =>
          expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe(
            "uncertain",
          ),
        );
        await f.rebind();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(f.send).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );
  it("retries restore-unavailable on idle without a socket reconnect", async () => {
    const f = await mount(new RpcError("unavailable", "A snapshot is being restored"));
    try {
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]).toMatchObject({
          state: "queued",
          attempted: true,
        }),
      );
      await f.emitIdle();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
      expect(f.send.mock.calls.map((call) => call[0].clientMessageId)).toEqual([f.id, f.id]);
    } finally {
      await f.close();
    }
  });
  it("retains an idle event arriving while the unavailable response is in flight", async () => {
    const error = new RpcError("unavailable", "A snapshot is being restored");
    const f = await mount(error, true);
    try {
      await f.emitIdle();
      await act(async () => {
        f.rejectFirst(error);
      });
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
    } finally {
      await f.close();
    }
  });
  it("does not spin when the host remains unavailable", async () => {
    const error = new RpcError("unavailable", "A snapshot is being restored");
    const f = await mount(error);
    f.send.mockRejectedValue(error);
    try {
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("queued"),
      );
      await f.render();
      expect(f.send).toHaveBeenCalledOnce();
      await f.emitIdle();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("queued"),
      );
      await f.render();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(f.send).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
  it("retries on restore completion after the earlier idle event was still unavailable", async () => {
    const error = new RpcError("unavailable", "A snapshot is being restored");
    const f = await mount(error);
    f.send.mockRejectedValueOnce(error);
    try {
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("queued"),
      );
      await f.emitIdle();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("queued"),
      );
      await f.emitSnapshotComplete();
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(3));
      expect(f.send.mock.calls.map((call) => call[0].clientMessageId)).toEqual([f.id, f.id, f.id]);
    } finally {
      await f.close();
    }
  });
  it.each([
    new RpcError("internal", "Uncertain acceptance"),
    new TypeError("Network receipt lost"),
  ])("does not retry an uncertain failure on idle: %s", async (error) => {
    const f = await mount(error);
    try {
      await vi.waitFor(async () =>
        expect((await f.vault.read<OfflinePayload>("payload"))?.outbox[0]?.state).toBe("uncertain"),
      );
      await f.emitIdle();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(f.send).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
});
