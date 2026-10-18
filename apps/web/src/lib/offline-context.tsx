import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OfflineVault } from "./offline-vault.ts";
import {
  emptyOfflinePayload,
  enqueueMessage,
  type OfflinePayload,
  type OutgoingMessage,
} from "./offline-data.ts";

interface OfflineContextValue {
  vault: OfflineVault | null;
  payload: OfflinePayload;
  error: string | null;
  mutate: (fn: (payload: OfflinePayload) => OfflinePayload) => Promise<OfflinePayload>;
  enqueue: (
    server: string,
    conversation: string,
    text: string,
    attachments: string[],
  ) => Promise<void>;
  report: (error: unknown) => void;
}
const OfflineContext = createContext<OfflineContextValue | null>(null);
export function clearOfflineQueries(client: QueryClient): void {
  void client.cancelQueries();
  client.clear();
}
export function useOffline(): OfflineContextValue {
  const context = useContext(OfflineContext);
  if (!context) throw new Error("Offline provider is missing");
  return context;
}

export function OfflineProvider({
  principal,
  children,
}: {
  principal: string;
  children: ReactNode;
}) {
  const [vault, setVault] = useState<OfflineVault | null>(null);
  const [payload, setPayload] = useState(emptyOfflinePayload);
  const [exists, setExists] = useState(false);
  const [passkey, setPasskey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const [dataScope, setDataScope] = useState(() => ({
    epoch: 0,
    client: new QueryClient({
      defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
    }),
  }));
  const dataScopeRef = useRef(dataScope);
  dataScopeRef.current = dataScope;
  const report = useCallback(
    (failure: unknown) =>
      setError(
        (failure instanceof Error ? failure.message : String(failure)) ||
          "Offline storage could not be opened. Check your passphrase, or use passphrase recovery if device verification failed.",
      ),
    [],
  );
  useEffect(() => {
    const generation = ++epoch.current;
    let current: OfflineVault | null = null;
    let wasUnlocked = false;
    let refreshSequence = 0;
    let unsubscribe: (() => void) | undefined;
    const refresh = async () => {
      if (!current || generation !== epoch.current) return;
      const sequence = ++refreshSequence;
      if (!current.unlocked && wasUnlocked) {
        wasUnlocked = false;
        setPayload(emptyOfflinePayload());
        const previous = dataScopeRef.current;
        clearOfflineQueries(previous.client);
        if (generation !== epoch.current) return;
        setDataScope({
          epoch: previous.epoch + 1,
          client: new QueryClient({
            defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
          }),
        });
      }
      const [known, device] = await Promise.all([current.exists(), current.hasPasskey()]);
      if (generation !== epoch.current || sequence !== refreshSequence) return;
      setExists(known);
      setPasskey(device);
      if (!current.unlocked) return;
      wasUnlocked = true;
      const data = await current.read<OfflinePayload>("payload");
      if (generation === epoch.current && sequence === refreshSequence && current.unlocked)
        setPayload(data ?? emptyOfflinePayload());
    };
    void OfflineVault.open(principal)
      .then(async (opened) => {
        if (generation !== epoch.current) {
          opened.close();
          return;
        }
        current = opened;
        const [known, device] = await Promise.all([opened.exists(), opened.hasPasskey()]);
        if (generation !== epoch.current) return;
        setVault(opened);
        setExists(known);
        setPasskey(device);
        unsubscribe = opened.subscribe(() => {
          void refresh().catch(report);
        });
      })
      .catch(report);
    return () => {
      epoch.current++;
      unsubscribe?.();
      clearOfflineQueries(dataScopeRef.current.client);
      current?.close();
    };
  }, [principal, report]);
  const mutate = useCallback(
    async (fn: (data: OfflinePayload) => OfflinePayload) => {
      if (!vault?.unlocked) throw new Error("Unlock offline messages first.");
      const generation = epoch.current;
      const data = await vault.update<OfflinePayload>("payload", (old) =>
        fn(old ?? emptyOfflinePayload()),
      );
      if (generation !== epoch.current || !vault.unlocked)
        throw new Error("Offline messages were locked.");
      setPayload(data);
      return data;
    },
    [vault],
  );
  const enqueue = useCallback(
    async (server: string, conversation: string, text: string, attachments: string[]) => {
      const message: OutgoingMessage = {
        id: crypto.randomUUID(),
        server,
        conversation,
        text,
        attachments,
        createdAt: new Date().toISOString(),
        state: "queued",
        attempted: false,
      };
      await mutate((data) => enqueueMessage(data, message));
    },
    [mutate],
  );
  const action = async (kind: "passphrase" | "device" | "enroll") => {
    if (!vault) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "enroll") {
        await vault.enablePasskey(passphrase);
        setPasskey(true);
      } else if (kind === "device") await vault.unlockPasskey();
      else if (exists) await vault.unlock(passphrase);
      else {
        if (passphrase.length < 12 || passphrase !== confirmation)
          throw new Error("Use at least 12 characters and matching passphrases.");
        await vault.create(passphrase);
        setExists(true);
      }
      if (vault.unlocked)
        setPayload((await vault.read<OfflinePayload>("payload")) ?? emptyOfflinePayload());
      setPassphrase("");
      setConfirmation("");
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <OfflineContext.Provider value={{ vault, payload, error, mutate, enqueue, report }}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 text-xs">
          {vault?.unlocked ? (
            <>
              <span className="flex-1 text-dim">
                Offline messages unlocked. Keep this app open and unlocked to send waiting messages.
              </span>
              {!passkey ? (
                <>
                  <input
                    aria-label="Recovery passphrase"
                    type="password"
                    placeholder="Passphrase to enable device unlock"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    className="rounded border border-line bg-bg px-2 py-1"
                  />
                  <button disabled={busy || !passphrase} onClick={() => void action("enroll")}>
                    Enable device unlock
                  </button>
                </>
              ) : null}
              <button onClick={() => vault.lock()}>Lock offline messages</button>
            </>
          ) : (
            <>
              <span className="text-dim">
                {exists ? "Unlock saved chats" : "Save recent chats encrypted on this device"}
              </span>
              <input
                aria-label="Offline passphrase"
                autoComplete={exists ? "current-password" : "new-password"}
                type="password"
                placeholder={exists ? "Passphrase" : "Passphrase (12+ characters)"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="rounded border border-line bg-bg px-2 py-1"
              />
              {!exists ? (
                <input
                  aria-label="Confirm offline passphrase"
                  type="password"
                  placeholder="Confirm passphrase"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  className="rounded border border-line bg-bg px-2 py-1"
                />
              ) : null}
              <button
                disabled={busy || !vault || !passphrase}
                onClick={() => void action("passphrase")}
              >
                {busy ? "Working…" : exists ? "Unlock" : "Enable offline messages"}
              </button>
              {passkey ? (
                <button disabled={busy} onClick={() => void action("device")}>
                  Unlock with device verification
                </button>
              ) : null}
            </>
          )}
          {error ? (
            <span role="alert" className="w-full text-danger">
              {error}
            </span>
          ) : null}
        </div>
        <QueryClientProvider client={dataScope.client}>
          <div key={dataScope.epoch} className="flex min-h-0 w-full flex-1 [&>div]:w-full">
            {children}
          </div>
        </QueryClientProvider>
      </div>
    </OfflineContext.Provider>
  );
}

export async function threadLock<T>(
  scope: string,
  server: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely coordinate queued messages. Web Locks are required.",
    );
  return navigator.locks.request(`nibblets-outbox:${scope}:${JSON.stringify([server, id])}`, fn);
}
