import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { z } from "zod";
import { OfflineVault } from "./offline-vault.ts";
import { OfflinePayload } from "./offline-data.ts";
import * as passkeys from "./offline-passkey.ts";

const passphrase = "a long recovery passphrase";
let factory: IDBFactory;
const Json = z.json();
const opened: OfflineVault<z.infer<typeof Json>>[] = [];

async function open(
  principal = "issuer:account-secret",
): Promise<OfflineVault<z.infer<typeof Json>>> {
  const vault = await OfflineVault.open(principal, Json);
  opened.push(vault);
  return vault;
}

async function stored(
  id: string,
  mutate?: (value: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const database = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open("nibblets-encrypted-offline-v1", 1);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("vaults", mutate ? "readwrite" : "readonly");
      const store = transaction.objectStore("vaults");
      const request = store.get(id);
      request.onsuccess = () => {
        if (mutate) {
          mutate(request.result);
          store.put(request.result, id);
        }
      };
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("location", { origin: "https://offline.example", hostname: "offline.example" });
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(name: string, work: () => Promise<T>): Promise<T> => {
        const operation = (locks.get(name) ?? Promise.resolve()).then(work, work);
        locks.set(
          name,
          operation.catch(() => undefined),
        );
        return operation;
      },
    },
  });
});
afterEach(() => {
  for (const vault of opened.splice(0)) vault.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("encrypted offline vault", () => {
  it("requires a recovery passphrase and persists only ciphertext across reload", async () => {
    const vault = await open();
    await expect(vault.create("short")).rejects.toThrow("12 characters");
    expect(await vault.exists()).toBe(false);
    await vault.create(passphrase);
    await vault.update("payload", () => ({
      messages: ["private conversation text"],
      title: "Secret title",
    }));
    const serialized = JSON.stringify(await stored(vault.id));
    for (const secret of [
      "private conversation text",
      "Secret title",
      "account-secret",
      passphrase,
      "CryptoKey",
    ])
      expect(serialized).not.toContain(secret);
    const loaded = await open();
    expect(loaded.unlocked).toBe(false);
    await expect(loaded.read("payload")).rejects.toThrow("Unlock");
    await expect(loaded.unlock("wrong recovery passphrase")).rejects.toThrow();
    expect(loaded.unlocked).toBe(false);
    await loaded.unlock(passphrase);
    expect(await loaded.read("payload")).toEqual({
      messages: ["private conversation text"],
      title: "Secret title",
    });
  });

  it("checks what it decrypts against the vault's schema", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => ({ text: "not a payload" }));
    const strict = await OfflineVault.open("issuer:account-secret", OfflinePayload);
    opened.push(strict);
    await expect(strict.unlock(passphrase)).rejects.toThrow();
    expect(strict.unlocked).toBe(false);
  });

  it("drops a saved chat it can't read but keeps queued messages", () => {
    const message = {
      id: "m",
      server: "s",
      conversation: "c",
      text: "hello",
      attachments: [],
      createdAt: "2026-10-18",
      state: "queued",
      attempted: false,
    };
    const parsed = OfflinePayload.parse({
      bindings: {},
      conversations: [{ id: "from an older version" }],
      outbox: [message],
    });
    expect(parsed.conversations).toEqual([]);
    expect(parsed.outbox).toEqual([message]);
    expect(() => OfflinePayload.parse({ bindings: {}, conversations: [], outbox: [{}] })).toThrow();
  });

  it("rejects ciphertext, revision, wrapper, and cross-principal substitution", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => ({ text: "private" }));
    const original = await stored(vault.id);
    await stored(vault.id, (value) => {
      value.revision = Number(value.revision) + 1;
    });
    await expect(vault.read("payload")).rejects.toThrow();
    await stored(vault.id, (value) => {
      Object.assign(value, original);
      value.payload = { ...(value.payload as object), ciphertext: "AAAA" };
    });
    await expect(vault.read("payload")).rejects.toThrow();
    await stored(vault.id, (value) => {
      Object.assign(value, original);
      value.passphrase = { ...(value.passphrase as object), ciphertext: "AAAA" };
    });
    vault.lock();
    await expect(vault.unlock(passphrase)).rejects.toThrow();
    const other = await open("issuer:other-account");
    await other.create(passphrase);
    await stored(other.id, (value) => {
      Object.assign(value, original);
    });
    other.lock();
    await expect(other.unlock(passphrase)).rejects.toThrow();
  });

  it("isolates both principal and origin and serialises concurrent tab updates", async () => {
    const first = await open();
    await first.create(passphrase);
    const second = await open();
    await second.unlock(passphrase);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        (index % 2 ? first : second).update(
          "payload",
          (value) => (typeof value === "number" ? value : 0) + 1,
        ),
      ),
    );
    expect(await first.read("payload")).toBe(5);
    expect(await (await open("other")).exists()).toBe(false);
    vi.stubGlobal("location", { origin: "https://another.example", hostname: "another.example" });
    expect(await (await open()).exists()).toBe(false);
  });

  it("invalidates late unlocks and propagates explicit lock across tabs", async () => {
    const first = await open();
    await first.create(passphrase);
    first.lock();
    const unlocking = first.unlock(passphrase);
    first.lock();
    await expect(unlocking).rejects.toThrow("locked");
    expect(first.unlocked).toBe(false);
    const second = await open();
    await first.unlock(passphrase);
    await second.unlock(passphrase);
    const locked = new Promise<void>((resolve) => {
      const unsubscribe = second.subscribe(() => {
        if (!second.unlocked) {
          unsubscribe();
          resolve();
        }
      });
    });
    first.lock();
    await locked;
    await expect(second.read("payload")).rejects.toThrow("Unlock");
  });

  it("rejects quota errors without replacing persisted data or publishing a change", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => "saved");
    const listener = vi.fn();
    vault.subscribe(listener);
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "vaults")
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      return originalPut.apply(this, args);
    });
    await expect(vault.update("payload", () => "unsaved")).rejects.toThrow();
    expect(await vault.read("payload")).toBe("saved");
    expect(listener).not.toHaveBeenCalled();
  });

  it("prevents a delayed encrypted write from persisting after lock", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => "saved");
    let started!: () => void;
    let release!: () => void;
    const encrypting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, key, data) => {
      const encrypted = await encrypt(algorithm, key, data);
      started();
      await barrier;
      return encrypted;
    });
    const updating = vault.update("payload", () => "late write");
    await encrypting;
    vault.lock();
    release();
    await expect(updating).rejects.toThrow("locked");
    await vault.unlock(passphrase);
    expect(await vault.read("payload")).toBe("saved");
  });

  it("aborts a write locked between IndexedDB put and transaction commit", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => "saved");
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const result = put.apply(this, args);
      vault.lock();
      return result;
    });
    await expect(vault.update("payload", () => "committed-after-lock")).rejects.toThrow();
    await vault.unlock(passphrase);
    expect(await vault.read("payload")).toBe("saved");
  });

  it.each(["locked", "unlocked"])(
    "rejects payload tamper while %s and clears the key",
    async (state) => {
      const vault = await open();
      await vault.create(passphrase);
      await vault.update("payload", () => "saved");
      await stored(vault.id, (value) => {
        value.payload = { ...(value.payload as object), ciphertext: "AAAA" };
      });
      if (state === "locked") vault.lock();
      await expect(
        state === "locked" ? vault.unlock(passphrase) : vault.read("payload"),
      ).rejects.toThrow();
      expect(vault.unlocked).toBe(false);
    },
  );

  it("clears the live key when a passphrase wrapper fails authentication", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await stored(vault.id, (value) => {
      value.passphrase = { ...(value.passphrase as object), ciphertext: "AAAA" };
    });
    await expect(vault.unlock(passphrase)).rejects.toThrow();
    expect(vault.unlocked).toBe(false);
  });

  it("bounds lock notifications when subscribers refresh malformed stored metadata", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => "saved");
    await stored(vault.id, (value) => {
      value.passphrase = { ...(value.passphrase as object), salt: "invalid" };
    });
    const corrupted = await stored(vault.id);
    const refreshes: Promise<unknown>[] = [];
    let notifications = 0;
    const unsubscribe = vault.subscribe(() => {
      notifications++;
      if (notifications >= 8) unsubscribe();
      refreshes.push(Promise.allSettled([vault.exists(), vault.hasPasskey()]));
    });
    await expect(vault.exists()).rejects.toThrow();
    for (let index = 0; index < refreshes.length; index++) await refreshes[index];
    unsubscribe();
    expect(notifications).toBe(1);
    expect(vault.unlocked).toBe(false);
    expect(await stored(vault.id)).toEqual(corrupted);
  });

  it("broadcasts repeated explicit locks even when the initiating tab remains locked", async () => {
    const first = await open();
    await first.create(passphrase);
    const second = await open();
    await second.unlock(passphrase);
    const nextLock = (): Promise<void> =>
      new Promise((resolve) => {
        const unsubscribe = second.subscribe(() => {
          if (!second.unlocked) {
            unsubscribe();
            resolve();
          }
        });
      });
    const initiallyLocked = nextLock();
    first.lock();
    await initiallyLocked;
    await second.unlock(passphrase);
    expect(first.unlocked).toBe(false);
    const lockedAgain = nextLock();
    first.lock();
    await lockedAgain;
    expect(second.unlocked).toBe(false);
  });

  it("rejects malformed metadata reads completing after close without reopening or posting to a closed channel", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await stored(vault.id, (value) => {
      value.version = 2;
    });
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const reading = Promise.allSettled([vault.exists(), vault.hasPasskey()]);
    vault.close();
    expect(post).toHaveBeenCalledExactlyOnceWith("lock");
    post.mockClear();
    const outcomes = await reading;
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toEqual(new Error("Invalid vault format."));
    expect(vault.unlocked).toBe(false);
    expect(() => vault.close()).not.toThrow();
    expect(() => vault.lock()).not.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps passphrase recovery when passkey setup fails or its wrapper is tampered", async () => {
    const vault = await open();
    await vault.create(passphrase);
    await vault.update("payload", () => "recoverable");
    const metadata = {
      credential: passkeys.encode(new Uint8Array([1])),
      input: passkeys.encode(passkeys.randomBytes(32)),
      salt: passkeys.encode(passkeys.randomBytes(32)),
    };
    const secret = passkeys.randomBytes(32);
    const create = vi
      .spyOn(passkeys, "createPasskey")
      .mockRejectedValueOnce(new DOMException("Cancelled", "NotAllowedError"));
    await expect(vault.enablePasskey(passphrase)).rejects.toThrow("Cancelled");
    expect(await vault.hasPasskey()).toBe(false);
    create.mockResolvedValue({ metadata, secret: secret.slice() });
    vi.spyOn(passkeys, "getPasskey").mockImplementation(async () => secret.slice());
    await vault.enablePasskey(passphrase);
    expect(await vault.hasPasskey()).toBe(true);
    vault.lock();
    await vault.unlockPasskey();
    expect(await vault.read("payload")).toBe("recoverable");
    await stored(vault.id, (value) => {
      value.passkey = {
        ...(value.passkey as object),
        input: passkeys.encode(passkeys.randomBytes(32)),
      };
    });
    await expect(vault.unlockPasskey()).rejects.toThrow();
    expect(vault.unlocked).toBe(false);
    await vault.unlock(passphrase);
    expect(await vault.read("payload")).toBe("recoverable");
  });

  it("fails closed without the required browser facilities and rejects malformed storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(OfflineVault.open("account", Json)).rejects.toThrow("unavailable");
    vi.stubGlobal("indexedDB", factory);
    const vault = await open();
    await vault.create(passphrase);
    await stored(vault.id, (value) => {
      value.passphrase = { salt: "invalid" };
    });
    await expect(vault.unlock(passphrase)).rejects.toThrow();
  });
});
