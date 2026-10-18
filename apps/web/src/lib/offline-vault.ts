import {
  createPasskey,
  decode,
  encode,
  getPasskey,
  passkeyWrappingKey,
  randomBytes,
} from "./offline-passkey.ts";
import type { PasskeyMetadata } from "./offline-passkey.ts";

interface Cipher {
  iv: string;
  ciphertext: string;
}
interface Envelope {
  version: 1;
  revision: number;
  id: string;
  passphrase: Cipher & { salt: string };
  passkey?: Cipher & PasskeyMetadata;
  payload: Cipher;
}

const text = new TextEncoder();

async function passphraseKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", text.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: decode(salt), iterations: 600_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Cipher> {
  const iv = randomBytes(12);
  return {
    iv: encode(iv),
    ciphertext: encode(
      new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext),
      ),
    ),
  };
}

async function decrypt(
  key: CryptoKey,
  cipher: Cipher,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (decode(cipher.iv).length !== 12) throw new Error("Invalid vault encryption envelope.");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(cipher.iv), additionalData: aad },
      key,
      decode(cipher.ciphertext),
    ),
  );
}

export class OfflineVault {
  private key: CryptoKey | null = null;
  private epoch = 0;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly writes = new Set<IDBTransaction>();
  private readonly channel: BroadcastChannel;
  private constructor(
    private readonly db: IDBDatabase,
    readonly id: string,
  ) {
    this.channel = new BroadcastChannel(`nibblets-vault:${id}`);
    this.channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "lock") this.clearKey();
      else if (event.data === "changed") this.notify();
    };
  }
  private get scope(): string {
    return this.id;
  }

  static async open(principal: string): Promise<OfflineVault> {
    if (
      !globalThis.crypto?.subtle ||
      !globalThis.indexedDB ||
      !navigator.locks ||
      !globalThis.BroadcastChannel
    )
      throw new Error("Encrypted offline storage is unavailable in this browser.");
    const scope = encode(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          text.encode(JSON.stringify([location.origin, principal])),
        ),
      ),
    );
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nibblets-encrypted-offline-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("vaults");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("Offline vault database upgrade is blocked. Close other tabs."));
    });
    return new OfflineVault(db, scope);
  }

  get unlocked(): boolean {
    return this.key !== null;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  private clearKey(): void {
    const wasUnlocked = this.key !== null;
    this.epoch++;
    this.key = null;
    for (const transaction of this.writes) {
      try {
        transaction.abort();
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
      }
    }
    if (wasUnlocked) this.notify();
  }
  lock(): void {
    this.clearKey();
    if (!this.closed) this.channel.postMessage("lock");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearKey();
    this.channel.postMessage("lock");
    this.channel.close();
    this.listeners.clear();
    this.db.close();
  }
  private check(epoch: number): void {
    if (epoch !== this.epoch) throw new Error("Offline vault was locked during the operation.");
  }
  private aad(name: string, ...metadata: unknown[]): Uint8Array<ArrayBuffer> {
    return text.encode(JSON.stringify([1, this.scope, name, ...metadata]));
  }
  private async envelope(): Promise<Envelope | undefined> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("vaults", "readonly");
      const request = transaction.objectStore("vaults").get(this.scope);
      transaction.oncomplete = () => {
        try {
          const value = request.result as Envelope | undefined;
          if (
            value &&
            (value.version !== 1 ||
              !Number.isSafeInteger(value.revision) ||
              value.revision < 1 ||
              typeof value.id !== "string" ||
              decode(value.id).length !== 32 ||
              !value.passphrase ||
              !value.payload ||
              decode(value.passphrase.salt).length !== 16)
          )
            throw new Error("Invalid vault format.");
          resolve(value);
        } catch (error) {
          this.lock();
          reject(error);
        }
      };
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? new Error("Offline storage read failed."));
    });
  }
  private async persist(
    value: Envelope,
    previous: number | undefined,
    epoch: number,
  ): Promise<void> {
    this.check(epoch);
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db.transaction("vaults", "readwrite");
      this.writes.add(transaction);
      const store = transaction.objectStore("vaults");
      const request = store.get(this.scope);
      let conflict: Error | undefined;
      request.onsuccess = () => {
        if (
          this.epoch !== epoch ||
          (request.result as Envelope | undefined)?.revision !== previous
        ) {
          conflict = new Error("Offline vault changed or locked. Retry the operation.");
          transaction.abort();
          return;
        }
        try {
          store.put(value, this.scope);
        } catch (error) {
          conflict = error instanceof Error ? error : new Error("Offline storage write failed.");
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        this.writes.delete(transaction);
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        this.writes.delete(transaction);
        reject(conflict ?? transaction.error ?? new Error("Offline storage write failed."));
      };
    });
    this.check(epoch);
    this.channel.postMessage("changed");
    this.notify();
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`nibblets-vault:${this.scope}`, work);
  }
  async exists(): Promise<boolean> {
    return (await this.envelope()) !== undefined;
  }
  async hasPasskey(): Promise<boolean> {
    return Boolean((await this.envelope())?.passkey);
  }

  async create(passphrase: string): Promise<void> {
    if (passphrase.length < 12) throw new Error("Use a passphrase of at least 12 characters.");
    const epoch = this.epoch;
    await this.exclusive(async () => {
      this.check(epoch);
      if (await this.envelope())
        throw new Error("An offline vault already exists for this account.");
      const raw = randomBytes(32);
      try {
        const id = encode(randomBytes(32));
        const salt = encode(randomBytes(16));
        const wrapped = await encrypt(
          await passphraseKey(passphrase, salt),
          raw,
          this.aad("passphrase", id, salt),
        );
        const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]);
        const payload = await encrypt(key, text.encode("null"), this.aad("payload", id, 1));
        await this.persist(
          { version: 1, revision: 1, id, passphrase: { salt, ...wrapped }, payload },
          undefined,
          epoch,
        );
        this.check(epoch);
        this.key = key;
        this.notify();
      } finally {
        raw.fill(0);
      }
    });
  }
  private async unwrapPassphrase(
    envelope: Envelope,
    passphrase: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return decrypt(
      await passphraseKey(passphrase, envelope.passphrase.salt),
      envelope.passphrase,
      this.aad("passphrase", envelope.id, envelope.passphrase.salt),
    );
  }
  private async accept(
    raw: Uint8Array<ArrayBuffer>,
    epoch: number,
    envelope: Envelope,
  ): Promise<void> {
    try {
      if (raw.length !== 32) throw new Error("Invalid offline vault key.");
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      await this.payloadWithKey(key, envelope);
      this.check(epoch);
      this.key = key;
      this.notify();
    } catch (error) {
      if (epoch === this.epoch) this.lock();
      throw error;
    } finally {
      raw.fill(0);
    }
  }
  async unlock(passphrase: string): Promise<void> {
    this.clearKey();
    const epoch = this.epoch;
    try {
      const envelope = await this.envelope();
      if (!envelope) throw new Error("Create an offline vault first.");
      await this.accept(await this.unwrapPassphrase(envelope, passphrase), epoch, envelope);
    } catch (error) {
      if (epoch === this.epoch) this.lock();
      throw error;
    }
  }
  private async payloadWithKey<T>(key: CryptoKey, envelope: Envelope): Promise<T | null> {
    const raw = await decrypt(
      key,
      envelope.payload,
      this.aad("payload", envelope.id, envelope.revision),
    );
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as T;
    } finally {
      raw.fill(0);
    }
  }
  private async plaintext<T>(envelope: Envelope): Promise<T | null> {
    if (!this.key) throw new Error("Unlock the offline vault first.");
    try {
      return await this.payloadWithKey<T>(this.key, envelope);
    } catch (error) {
      this.lock();
      throw error;
    }
  }
  async read<T>(record: "payload"): Promise<T | null> {
    const epoch = this.epoch;
    if (record !== "payload") throw new Error("Unknown vault record.");
    const envelope = await this.envelope();
    if (!envelope || !this.key) throw new Error("Unlock the offline vault first.");
    const value = await this.plaintext<T>(envelope);
    this.check(epoch);
    return value;
  }
  async update<T>(record: "payload", mutate: (current: T | null) => T): Promise<T> {
    const epoch = this.epoch;
    if (record !== "payload") throw new Error("Unknown vault record.");
    return this.exclusive(async () => {
      const envelope = await this.envelope();
      if (!envelope || !this.key) throw new Error("Unlock the offline vault first.");
      const current = await this.plaintext<T>(envelope);
      this.check(epoch);
      const value = mutate(current);
      const revision = envelope.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Offline vault revision limit reached.");
      const raw = text.encode(JSON.stringify(value));
      let payload: Cipher;
      try {
        payload = await encrypt(this.key, raw, this.aad("payload", envelope.id, revision));
      } finally {
        raw.fill(0);
      }
      await this.persist({ ...envelope, revision, payload }, envelope.revision, epoch);
      this.check(epoch);
      return value;
    });
  }
  async enablePasskey(passphrase: string): Promise<void> {
    const epoch = this.epoch;
    await this.exclusive(async () => {
      const envelope = await this.envelope();
      if (!envelope || !this.key) throw new Error("Unlock the offline vault first.");
      const raw = await this.unwrapPassphrase(envelope, passphrase);
      try {
        this.check(epoch);
        const { metadata, secret } = await createPasskey(envelope.id);
        const wrapping = await passkeyWrappingKey(secret, metadata, this.scope);
        const aad = this.aad("passkey", envelope.id, metadata);
        const wrapped = await encrypt(wrapping, raw, aad);
        const verified = await decrypt(wrapping, wrapped, aad);
        try {
          if (
            !raw.every((byte, index) => byte === verified[index]) ||
            verified.length !== raw.length
          )
            throw new Error("Passkey verification failed.");
        } finally {
          verified.fill(0);
        }
        // Wrapper changes preserve the revision authenticated by the payload.
        await this.persist(
          { ...envelope, passkey: { ...metadata, ...wrapped } },
          envelope.revision,
          epoch,
        );
      } finally {
        raw.fill(0);
      }
    });
  }
  async unlockPasskey(): Promise<void> {
    this.clearKey();
    const epoch = this.epoch;
    try {
      const envelope = await this.envelope();
      if (!envelope?.passkey)
        throw new Error("No encryption passkey is configured. Use your passphrase.");
      const { credential, input, salt } = envelope.passkey;
      const metadata = { credential, input, salt };
      const wrapping = await passkeyWrappingKey(await getPasskey(metadata), metadata, this.scope);
      await this.accept(
        await decrypt(wrapping, envelope.passkey, this.aad("passkey", envelope.id, metadata)),
        epoch,
        envelope,
      );
    } catch (error) {
      if (epoch === this.epoch) this.lock();
      throw error;
    }
  }
}
