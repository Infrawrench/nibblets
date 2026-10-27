import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, LogIn, Trash2 } from "lucide-react";
import type { ThirdParty, ThirdPartyKind } from "@nibblets/protocol";
import type { ThirdPartiesApi } from "../../lib/central.ts";
import { keys } from "../../lib/servers.tsx";
import { signInTo, useThirdParties, useThirdPartiesApi } from "../../lib/thirdParties.ts";
import { relativeTime } from "../../lib/time.ts";
import { Button } from "../ui/Button.tsx";
import { Input, SectionHeading } from "../ui/Field.tsx";
import { ThirdPartyAvatar } from "./ThirdPartyAvatar.tsx";

/** How long after starting to sign in elsewhere (in the desktop app, the browser) to watch for it. */
const WATCH_MS = 10 * 60_000;
const WATCH_EVERY_MS = 3_000;

/**
 * Takes a query parameter Connect sent the person back with, once, wiping
 * it from the address: `third-party-error` when a sign-in on a third
 * party's site didn't work, `third-party-finish` (its state) when it did
 * and is waiting for them to finish it here, signed in.
 */
function takeParam(name: "third-party-error" | "third-party-finish"): string | null {
  const search = new URLSearchParams(window.location.search);
  const value = search.get(name);
  if (!value) return null;
  search.delete(name);
  const query = search.toString();
  history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  return value;
}

/** Finishes a sign-in Connect sent the person back with, then opens what it connected. */
function useFinishSignIn(api: ThirdPartiesApi | null): {
  finishing: boolean;
  error: string | null;
} {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [state] = useState(() => takeParam("third-party-finish"));
  const [error, setError] = useState(() => takeParam("third-party-error"));
  const [finishing, setFinishing] = useState(state !== null);
  const started = useRef(false);
  useEffect(() => {
    if (!api || !state || started.current) return;
    started.current = true;
    void api
      .finishSignIn(state)
      .then(async (id) => {
        await qc.invalidateQueries({ queryKey: keys.thirdParties() });
        void navigate({ to: "/t/$id", params: { id } });
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFinishing(false));
  }, [api, state, qc, navigate]);
  return { finishing, error };
}

/**
 * Settings → Third-party agents, in Nibblets Connect: connecting other
 * companies' agents to the account, so they're in the sidebar beside the
 * nibblets. Each is a plugin in Connect, which says what it's called and
 * how it's connected; nothing here knows one from another.
 */
export function ThirdPartiesSection() {
  const api = useThirdPartiesApi();
  const [watchUntil, setWatchUntil] = useState(0);
  const watching = watchUntil > Date.now();
  const list = useThirdParties(watching ? { every: WATCH_EVERY_MS } : {});
  const { finishing, error } = useFinishSignIn(api);
  if (!api || !list.data || list.data.kinds.length === 0) return null;
  const { enabled, kinds, parties } = list.data;
  return (
    <>
      <SectionHeading>Third-party agents</SectionHeading>
      <p className="text-xs text-faint">
        Other companies' agents, in the sidebar beside your nibblets: talk to them and answer what
        they're waiting on, from here. Nibblets Connect keeps their credentials and talks to them
        for you, so they never reach this page.
      </p>
      {finishing ? <p className="text-xs text-dim">Finishing connecting…</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {!enabled ? (
        <p className="text-xs text-dim">
          This Nibblets Connect has no key to keep their credentials with, so none can be connected
          yet.
        </p>
      ) : null}
      {kinds.map((kind) => (
        <KindRow
          key={kind.id}
          api={api}
          kind={kind}
          enabled={enabled}
          parties={parties.filter((p) => p.plugin === kind.id)}
          onSigningIn={() => setWatchUntil(Date.now() + WATCH_MS)}
        />
      ))}
    </>
  );
}

function KindRow({
  api,
  kind,
  enabled,
  parties,
  onSigningIn,
}: {
  api: ThirdPartiesApi;
  kind: ThirdPartyKind;
  enabled: boolean;
  parties: readonly ThirdParty[];
  onSigningIn: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [token, setToken] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      onSigningIn();
      await signInTo(api, kind.id);
    });

  const connectToken = () =>
    run(async () => {
      const id = await api.connectToken(kind.id, token.trim());
      setToken("");
      setPasting(false);
      await qc.invalidateQueries({ queryKey: keys.thirdParties() });
      void navigate({ to: "/t/$id", params: { id } });
    });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <ThirdPartyAvatar kind={kind} size={24} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{kind.name}</span>
          <span className="text-xs text-dim">{kind.description}</span>
        </div>
        {kind.signIn ? (
          <Button size="sm" disabled={!enabled || busy} onClick={() => void signIn()}>
            <LogIn />
            {parties.length > 0 ? "Connect another" : "Connect"}
          </Button>
        ) : null}
      </div>
      {parties.map((party) => (
        <PartyRow key={party.id} api={api} kind={kind} party={party} />
      ))}
      {kind.token && enabled ? (
        pasting ? (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void connectToken();
            }}
          >
            <label className="text-xs text-dim" htmlFor={`token-${kind.id}`}>
              {kind.token.label}
            </label>
            <div className="flex gap-1.5">
              <Input
                id={`token-${kind.id}`}
                type="password"
                autoComplete="off"
                value={token}
                placeholder={kind.token.placeholder}
                onChange={(e) => setToken(e.target.value)}
                className="flex-1"
              />
              <Button type="submit" size="md" disabled={busy || !token.trim()}>
                {busy ? "Checking…" : "Connect"}
              </Button>
            </div>
            <span className="text-2xs text-faint">{kind.token.hint}</span>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setPasting(true)}
            className="flex items-center gap-1 self-start text-2xs text-faint hover:text-dim"
          >
            <KeyRound className="size-3" />
            Use {kind.token.label === "API token" ? "an API token" : kind.token.label} instead
          </button>
        )
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function PartyRow({
  api,
  kind,
  party,
}: {
  api: ThirdPartiesApi;
  kind: ThirdPartyKind;
  party: ThirdParty;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Asking twice to forget it, so a stray click doesn't.
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  const forget = async () => {
    try {
      await api.remove(party.id);
      await qc.invalidateQueries({ queryKey: keys.thirdParties() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{party.account}</span>
          <span className="text-2xs text-faint">
            {party.state === "revoked" ? (
              <span className="text-danger">
                {kind.name} no longer takes it. Connect again to bring it back.
              </span>
            ) : (
              <>Connected {relativeTime(party.connectedAt)}</>
            )}
          </span>
        </div>
        <Button
          size="sm"
          variant={confirming ? "danger" : "ghost"}
          onClick={() => (confirming ? void forget() : setConfirming(true))}
        >
          <Trash2 />
          {confirming ? "Forget it" : "Forget"}
        </Button>
      </div>
      {confirming ? (
        <span className="text-2xs text-faint">
          Its access stays live in {kind.name} until you revoke it there too.
        </span>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
