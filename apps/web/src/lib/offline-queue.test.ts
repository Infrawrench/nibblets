// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://offline.example"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { BroadcastChannel } from "node:worker_threads";
import { IDBFactory } from "fake-indexeddb";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { OfflineVault } from "./offline-vault.ts";
import { emptyOfflinePayload, type OfflinePayload } from "./offline-data.ts";
import { createMockServer } from "./mock.ts";
import { drainHead } from "./offline-outbox.ts";
import { useOffline } from "./offline-context.tsx";
import { useServers } from "./servers.tsx";
import { useQueuedMessages } from "../components/thread/QueuedMessages.tsx";

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
