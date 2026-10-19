import { useState } from "react";
import { useOffline } from "../lib/offline-context.tsx";
import { canRecall, type OfflineConversation as Conversation } from "../lib/offline-data.ts";
import { Hamster } from "./hamster/Hamster.tsx";
import { MobileBack } from "./MobileBack.tsx";
import {
  QueuedMessages,
  caretOnFirstVisualLine,
  useQueuedMessages,
} from "./thread/QueuedMessages.tsx";

export function OfflineConversation({ conversation }: { conversation: Conversation }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const queue = useQueuedMessages(conversation.server, conversation.id, text, setText);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await queue.send([]);
    } catch (error) {
      queue.offline.report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <MobileBack />
        <Hamster look={conversation.look} size={26} status="stopped" />
        <span className="font-semibold">{conversation.name}</span>
      </header>
      <p className="border-b border-line px-4 py-2 text-xs text-dim">
        Offline · saved {new Date(conversation.savedAt).toLocaleString()} ·{" "}
        {conversation.systemName}. Tools, files and settings require the host.
      </p>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-6">
        {conversation.messages.map((message) => (
          <div
            key={message.id}
            className={`mx-auto max-w-[46rem] whitespace-pre-wrap break-words ${message.role === "user" ? "rounded-xl bg-panel p-3" : "px-3"}`}
          >
            <div className="mb-1 text-xs text-faint">
              {message.role === "user" ? "You" : conversation.name}
            </div>
            {message.text}
          </div>
        ))}
      </div>
      <div className="safe-bottom mx-3 mb-3 rounded-2xl border border-line bg-surface">
        <QueuedMessages queue={queue} />
        <textarea
          aria-label="Offline message"
          disabled={busy}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              canRecall(
                { ...event, composing: event.nativeEvent.isComposing },
                event.currentTarget,
                caretOnFirstVisualLine(event.currentTarget),
              )
            ) {
              event.preventDefault();
              void queue.recall();
            }
          }}
          placeholder="Queue a message for when this host returns…"
          rows={3}
          className="w-full resize-none bg-transparent p-3 outline-none"
        />
        <div className="flex items-center gap-2 px-3 pb-3 text-xs">
          <span className="flex-1 text-faint">
            New uploads require this host · five waiting messages per chat
          </span>
          <button disabled={busy || !text.trim()} onClick={() => void send()}>
            {queue.editing ? "Save queued message" : "Queue send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SavedConversation({ server, id }: { server: string; id: string }) {
  const offline = useOffline();
  const saved = offline.payload.conversations.find((c) => c.server === server && c.id === id);
  if (!saved)
    return (
      <div className="m-auto text-sm text-dim">
        Unlock offline messages to see saved chats from this host.
      </div>
    );
  return <OfflineConversation key={`${server}/${id}`} conversation={saved} />;
}
