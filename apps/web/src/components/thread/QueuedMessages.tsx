import { useEffect, useRef, useState } from "react";
import { useOffline, threadLock } from "../../lib/offline-context.tsx";
import {
  enqueueMessage,
  type OfflinePayload,
  type OutgoingMessage,
} from "../../lib/offline-data.ts";

export function useQueuedMessages(
  server: string,
  id: string,
  text: string,
  setText: (value: string) => void,
) {
  const offline = useOffline();
  const [editing, setEditing] = useState<OutgoingMessage | null>(null);
  const release = useRef<(() => void) | null>(null);
  const committing = useRef(false);
  const releaseRequested = useRef(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const reserving = useRef(false);
  const parked = useRef("");
  const latestText = useRef(text);
  latestText.current = text;
  const mounted = useRef(true);
  const pending = offline.payload.outbox.filter(
    (m) => m.server === server && m.conversation === id && m.state !== "accepted",
  );
  const releaseLease = () => {
    if (committing.current) {
      releaseRequested.current = true;
      return;
    }
    release.current?.();
    release.current = null;
    releaseRequested.current = false;
  };
  const done = () => {
    releaseLease();
    if (mounted.current) setEditing(null);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseLease();
    };
  }, [server, id]);
  useEffect(() => {
    if (!offline.vault?.unlocked) {
      releaseLease();
      setEditing(null);
      setText("");
    }
  }, [offline.vault?.unlocked]);
  const recall = async (chosen?: string) => {
    const vault = offline.vault;
    if (!vault?.unlocked || release.current || reserving.current) return;
    reserving.current = true;
    let ready: () => void = () => undefined;
    const reserved = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const operation = threadLock(vault.id, server, id, async () => {
      const data = await vault.read<OfflinePayload>("payload");
      if (!mounted.current || !vault.unlocked) {
        reserving.current = false;
        ready();
        return;
      }
      const message = data?.outbox.findLast(
        (m) =>
          m.server === server &&
          m.conversation === id &&
          !m.attempted &&
          m.state === "queued" &&
          (!chosen || m.id === chosen),
      );
      if (!message) {
        reserving.current = false;
        ready();
        return;
      }
      parked.current = latestText.current;
      setText(message.text);
      setEditing(message);
      await new Promise<void>((resolve) => {
        release.current = resolve;
        reserving.current = false;
        ready();
      });
    });
    void operation.catch((failure) => {
      reserving.current = false;
      ready();
      offline.report(failure);
    });
    await reserved;
  };
  const cancel = () => {
    if (mounted.current) setText(parked.current);
    done();
  };
  const send = async (attachments: string[]) => {
    if (committing.current) throw new Error("This queued edit is still being saved.");
    if (editing) {
      committing.current = true;
      setSavingEdit(true);
      try {
        await offline.mutate((data) => {
          const existing = data.outbox.find((m) => m.id === editing.id);
          if (!existing || existing.attempted || existing.state !== "queued")
            throw new Error("This message is already being sent.");
          const updated = { ...existing, text: text.trim() };
          enqueueMessage(
            { ...data, outbox: data.outbox.filter((m) => m.id !== editing.id) },
            updated,
          );
          return { ...data, outbox: data.outbox.map((m) => (m.id === editing.id ? updated : m)) };
        });
        if (mounted.current) setText(parked.current);
        releaseRequested.current = true;
      } finally {
        committing.current = false;
        if (mounted.current) setSavingEdit(false);
        if (releaseRequested.current) done();
      }
    } else {
      await offline.enqueue(server, id, text.trim(), attachments);
      if (mounted.current) setText("");
    }
  };
  const remove = async (message: OutgoingMessage) => {
    const vault = offline.vault;
    if (!vault?.unlocked) return;
    await threadLock(vault.id, server, id, () =>
      offline.mutate((data) => {
        const current = data.outbox.find((m) => m.id === message.id);
        if (current?.attempted && current.state !== "rejected")
          throw new Error("A message awaiting a host receipt cannot be cancelled locally.");
        return { ...data, outbox: data.outbox.filter((m) => m.id !== message.id) };
      }),
    );
  };
  return { offline, pending, editing, savingEdit, recall, cancel, send, remove };
}

export function QueuedMessages({ queue }: { queue: ReturnType<typeof useQueuedMessages> }) {
  if (!queue.pending.length) return null;
  return (
    <div className="max-h-40 overflow-y-auto border-b border-line px-4 py-2 text-xs">
      <div className="mb-1 text-faint">
        {queue.pending.length} waiting message{queue.pending.length === 1 ? "" : "s"}
      </div>
      {queue.pending.map((message) => (
        <div key={message.id} className="flex items-center gap-2 py-1">
          <span className="min-w-0 flex-1 truncate" title={message.text}>
            {message.text || `${message.attachments.length} attachments`}
          </span>
          <span
            className={message.state === "rejected" ? "text-danger" : "text-dim"}
            title={message.detail}
          >
            {message.state === "queued"
              ? "Queued"
              : message.state === "uncertain"
                ? "Awaiting receipt"
                : (message.detail ?? "Rejected")}
          </span>
          {!message.attempted && !queue.editing ? (
            <button onClick={() => void queue.recall(message.id)}>Edit</button>
          ) : null}
          {(!message.attempted || message.state === "rejected") && !queue.editing ? (
            <button onClick={() => void queue.remove(message).catch(queue.offline.report)}>
              {message.state === "rejected" ? "Dismiss" : "Cancel"}
            </button>
          ) : null}
        </div>
      ))}
      {queue.editing ? (
        <div className="mt-1 text-dim">
          Editing queued message
          {queue.editing.attachments.length
            ? ` · ${queue.editing.attachments.length} existing attachment(s) retained`
            : ""}
          .{" "}
          <button disabled={queue.savingEdit} onClick={queue.cancel}>
            Cancel edit
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function caretOnFirstVisualLine(area: HTMLTextAreaElement): boolean {
  const style = getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const key of [
    "font",
    "letterSpacing",
    "padding",
    "border",
    "boxSizing",
    "wordBreak",
    "overflowWrap",
    "lineHeight",
  ] as const)
    mirror.style[key] = style[key];
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    width: `${area.clientWidth}px`,
  });
  const before = document.createTextNode(area.value.slice(0, area.selectionStart));
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  const start = document.createElement("span");
  start.textContent = "\u200b";
  mirror.append(start, before, marker);
  document.body.append(mirror);
  const first =
    Math.abs(marker.getBoundingClientRect().top - start.getBoundingClientRect().top) < 2;
  mirror.remove();
  return first;
}
