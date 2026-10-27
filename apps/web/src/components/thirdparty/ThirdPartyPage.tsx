import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, ClipboardCheck, Loader2, X } from "lucide-react";
import type { ThirdPartyAnswer, ThirdPartyMessage } from "@nibblets/protocol";
import type { ThirdPartiesApi } from "../../lib/central.ts";
import { keys } from "../../lib/servers.tsx";
import {
  awaitingReply,
  connected,
  newClientId,
  signInTo,
  stillOutgoing,
  useThirdParties,
  useThirdPartiesApi,
  type Connected,
  type Outgoing,
} from "../../lib/thirdParties.ts";
import { cn } from "../../lib/cn.ts";
import { MarkdownLink } from "../thread/ThreadView.tsx";
import { MobileBack } from "../MobileBack.tsx";
import { Button } from "../ui/Button.tsx";
import { RequestCard } from "./RequestCard.tsx";
import { ThirdPartyAvatar } from "./ThirdPartyAvatar.tsx";

/** While it's working or a reply is on its way: check for replies often. */
const BUSY_EVERY_MS = 3_000;
/** Otherwise now and then, for replies that come later (long research, say). */
const IDLE_EVERY_MS = 30_000;
const REQUESTS_EVERY_MS = 20_000;

const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function ThirdPartyPage({ id }: { id: string }) {
  const api = useThirdPartiesApi();
  const list = useThirdParties();
  const found = connected(list.data).find((c) => c.party.id === id);
  if (!api) return <Missing text="Third parties are in Nibblets Connect." />;
  if (list.isPending) return <div className="flex-1" />;
  if (!found) return <Missing text="This isn't connected any more." />;
  return <ThirdPartyView api={api} connected={found} />;
}

function ThirdPartyView({
  api,
  connected: { party, kind },
}: {
  api: ThirdPartiesApi;
  connected: Connected;
}) {
  const qc = useQueryClient();
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const live = party.state === "live";
  const working = party.activity?.working ?? false;
  const waiting = party.activity?.waiting ?? 0;
  const [panel, setPanel] = useState(waiting > 0);
  // Asks more often while there's something to watch for: work, or an unanswered message.
  const every = (messages: readonly ThirdPartyMessage[]) =>
    working || outbox.length > 0 || awaitingReply(messages, Date.now())
      ? BUSY_EVERY_MS
      : IDLE_EVERY_MS;

  const thread = useQuery({
    queryKey: keys.thirdPartyThread(party.id),
    queryFn: () => api.thread(party.id),
    enabled: live && party.abilities.chat,
    refetchInterval: (query) => every(query.state.data ?? []),
  });
  useThirdParties({ every: every(thread.data ?? []) });
  const requests = useQuery({
    queryKey: keys.thirdPartyRequests(party.id),
    queryFn: () => api.requests(party.id),
    enabled: live && party.abilities.requests,
    refetchInterval: REQUESTS_EVERY_MS,
  });

  // A revoked connection shows up in the list; ask it again once a call says so.
  const refreshList = () => void qc.invalidateQueries({ queryKey: keys.thirdParties() });
  useEffect(() => {
    if (thread.isError || requests.isError) refreshList();
  }, [thread.isError, requests.isError]);

  const messages = thread.data ?? [];
  const pending = stillOutgoing(outbox, messages);
  // Drop what's arrived, so the busy polling stops once the thread has it.
  useEffect(() => {
    if (pending.length !== outbox.length) setOutbox(pending);
  }, [pending.length, outbox.length]);

  const send = async (text: string) => {
    const message: Outgoing = { clientId: newClientId(), text, sentAt: Date.now(), failed: null };
    setOutbox((o) => [...o, message]);
    try {
      await api.send(party.id, text, message.clientId);
      void qc.invalidateQueries({ queryKey: keys.thirdPartyThread(party.id) });
      refreshList();
    } catch (err) {
      const failed = err instanceof Error ? err.message : String(err);
      setOutbox((o) => o.map((m) => (m.clientId === message.clientId ? { ...m, failed } : m)));
    }
  };

  const act = async (request: string, action: string, answer: ThirdPartyAnswer) => {
    try {
      await api.act(party.id, request, action, answer);
    } finally {
      void qc.invalidateQueries({ queryKey: keys.thirdPartyRequests(party.id) });
      refreshList();
    }
  };

  const subtitle = !live
    ? `${kind.name} no longer takes this connection`
    : (party.problem ?? (working ? "Working" : null));

  return (
    <div className="flex min-w-0 flex-1">
      <div className="safe-top relative flex min-w-0 flex-1 flex-col">
        <header className="shell-titlebar flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-4 max-sm:gap-2 max-sm:px-3">
          <MobileBack />
          <ThirdPartyAvatar kind={kind} size={26} />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <span className="min-w-0 truncate">{kind.name}</span>
              {waiting > 0 ? (
                <span className="shrink-0 text-xs font-normal text-warning">
                  · {waiting} to review
                </span>
              ) : null}
            </span>
            <span className="truncate text-2xs text-faint">
              {party.account}
              {subtitle ? (
                <span className={cn(!live || party.problem ? "text-danger" : "text-working")}>
                  {" · "}
                  {subtitle}
                </span>
              ) : null}
            </span>
          </div>
          {party.abilities.requests && live ? (
            <Button
              size="sm"
              variant={panel ? "secondary" : "ghost"}
              title={panel ? "Hide what's waiting" : "Show what's waiting"}
              onClick={() => setPanel(!panel)}
            >
              <ClipboardCheck />
              {waiting > 0 ? waiting : null}
            </Button>
          ) : null}
        </header>
        {!live ? (
          <Reconnect api={api} connected={{ party, kind }} />
        ) : party.abilities.chat ? (
          <>
            <Conversation
              name={kind.name}
              messages={messages}
              pending={pending}
              working={working}
              loading={thread.isPending}
              error={thread.error?.message ?? null}
            />
            <Composer name={kind.name} onSend={send} />
          </>
        ) : (
          <Missing
            text={`This connection can't message ${kind.name}. Connect it again to allow it.`}
          />
        )}
      </div>
      {panel && live && party.abilities.requests ? (
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-line bg-panel max-lg:safe-top max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:w-full max-lg:border-l-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="flex-1 text-sm font-semibold">Waiting on you</span>
            <Button size="icon" variant="ghost" title="Close" onClick={() => setPanel(false)}>
              <X />
            </Button>
          </div>
          <div className="safe-bottom flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {requests.isPending ? (
              <Loader2 className="mx-auto mt-6 size-4 animate-spin text-faint" />
            ) : requests.isError ? (
              <p className="text-sm text-danger">{requests.error.message}</p>
            ) : requests.data.length === 0 ? (
              <p className="py-8 text-center text-sm text-faint">Nothing's waiting on you.</p>
            ) : (
              requests.data.map((r) => (
                <RequestCard
                  key={r.id}
                  request={r}
                  name={kind.name}
                  onAct={(action, answer) => act(r.id, action, answer)}
                />
              ))
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function Conversation({
  name,
  messages,
  pending,
  working,
  loading,
  error,
}: {
  name: string;
  messages: readonly { id: string; role: "person" | "agent"; text: string }[];
  pending: readonly Outgoing[];
  working: boolean;
  loading: boolean;
  error: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Follow the bottom while messages arrive, unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-[46rem] flex-col gap-3 px-5 pt-6 pb-40">
        {loading ? <Loader2 className="mx-auto size-4 animate-spin text-faint" /> : null}
        {!loading && messages.length === 0 && pending.length === 0 ? (
          <div className="py-16 text-center text-sm text-faint">
            Nothing here yet. Ask {name} for something.
          </div>
        ) : null}
        {messages.map((m) =>
          m.role === "person" ? (
            <PersonBubble key={m.id} text={m.text} />
          ) : (
            <div key={m.id} className="prose-chat">
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                {m.text}
              </Markdown>
            </div>
          ),
        )}
        {pending.map((m) => (
          <PersonBubble key={m.clientId} text={m.text} failed={m.failed} sending={!m.failed} />
        ))}
        {working ? (
          <span className="flex items-center gap-1.5 text-xs text-faint">
            <Loader2 className="size-3 animate-spin" />
            {name} is working
          </span>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

function PersonBubble({
  text,
  failed = null,
  sending = false,
}: {
  text: string;
  failed?: string | null;
  sending?: boolean;
}) {
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1 self-end">
      <div
        className={cn(
          "rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-base whitespace-pre-wrap",
          sending && "opacity-60",
        )}
      >
        {text}
      </div>
      {failed ? <span className="text-2xs text-danger">Not sent: {failed}</span> : null}
    </div>
  );
}

function Composer({ name, onSend }: { name: string; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    if (area.current) area.current.style.height = "auto";
    void onSend(message);
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:px-2">
      <div className="pointer-events-auto mx-auto flex max-w-[46rem] items-end rounded-3xl border border-black/8 bg-surface/85 shadow-float backdrop-blur-md transition-colors focus-within:border-accent/50 dark:border-white/8 dark:focus-within:border-accent/50">
        <textarea
          ref={area}
          value={text}
          rows={1}
          maxLength={4000}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            // On a touchscreen, Return is a new line; the send button sends.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${name}…`}
          className="block max-h-56 min-w-0 flex-1 resize-none bg-transparent px-4 py-3 text-base outline-none placeholder:text-faint"
        />
        <button
          type="button"
          disabled={!text.trim()}
          onClick={send}
          className="m-2 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text transition-opacity hover:bg-accent-hover disabled:opacity-30"
          aria-label="Send"
          title="Send (Enter)"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** A connection the third party stopped taking: sign in again, which brings this one back. */
function Reconnect({ api, connected: { kind } }: { api: ThirdPartiesApi; connected: Connected }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <ThirdPartyAvatar kind={kind} size={48} />
      <p className="max-w-sm text-sm text-dim">
        {kind.name} no longer takes this connection. It may have been revoked there. Connect it
        again to carry on.
      </p>
      {kind.signIn ? (
        <Button
          variant="primary"
          onClick={() => void signInTo(api, kind.id).catch((err: Error) => setError(err.message))}
        >
          Connect {kind.name} again
        </Button>
      ) : (
        <p className="text-xs text-faint">Add a new token in Settings.</p>
      )}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function Missing({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center text-sm text-faint">{text}</div>;
}
