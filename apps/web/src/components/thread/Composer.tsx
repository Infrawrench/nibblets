import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Paperclip, Square, Upload, X } from "lucide-react";
import type { FileRef, Nibblet } from "@nibblet/protocol";
import { formatBytes, isImage } from "../../lib/files.ts";
import { FileTypeIcon } from "../files/Files.tsx";
import { useModels } from "../../lib/models.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { EffortMenu } from "../EffortMenu.tsx";
import { cn } from "../../lib/cn.ts";
import type { ServerConnection } from "../../lib/connection.ts";
import { canRecall } from "../../lib/offline-data.ts";
import { QueuedMessages, caretOnFirstVisualLine, useQueuedMessages } from "./QueuedMessages.tsx";

/** The floating message card at the foot of a thread. */
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Composer({
  connection,
  nibblet,
  running,
}: {
  connection: ServerConnection;
  nibblet: Nibblet;
  running: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const queue = useQueuedMessages(connection.id, nibblet.id, text, setText);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { attachments, add, remove, clear, dragging } = useAttachments(
    connection,
    nibblet.id,
    !sending && !queue.editing,
  );
  const uploading = attachments.some((a) => a.ref === null && a.error === null);
  const ready = attachments.flatMap((a) => (a.ref ? [a.ref] : []));
  const canSend = (text.trim().length > 0 || ready.length > 0) && !uploading && !sending;
  const catalogue = useModels(connection);
  const model = catalogue.find(nibblet.harness, nibblet.model);
  const asleep = nibblet.status === "stopped";

  // Clears straight away: the message shows up in the thread as soon as the
  // server has it, and comes back to the box only if sending failed.
  const send = async () => {
    const message = text.trim();
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    if (area.current) area.current.style.height = "auto";
    try {
      if (queue.offline.vault?.unlocked) {
        await queue.send(ready.map((r) => r.fileId));
      } else {
        if (running)
          throw new Error("Unlock offline messages to queue while this nibblet is working.");
        await connection.client.nibblets.send({
          id: nibblet.id,
          text: message,
          attachments: ready.map((r) => r.fileId),
        });
        setText("");
      }
      if (!queue.editing) clear();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
      area.current?.focus();
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:px-2">
      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-xl border border-accent/50 bg-surface px-4 py-3 text-sm font-medium shadow-float">
            <Upload className="size-4 text-accent" />
            Drop to attach for {nibblet.name}
          </div>
        </div>
      ) : null}
      <div className="pointer-events-auto mx-auto max-w-[46rem] rounded-3xl border border-black/8 bg-surface/85 shadow-float backdrop-blur-md transition-colors focus-within:border-accent/50 dark:border-white/8 dark:focus-within:border-accent/50">
        <QueuedMessages queue={queue} />
        {sendError ? (
          <p role="alert" className="px-4 pt-2 text-xs text-danger">
            {sendError}
          </p>
        ) : null}
        {attachments.length > 0 && !queue.editing ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <AttachmentChip key={a.key} attachment={a} onRemove={() => remove(a.key)} />
            ))}
          </div>
        ) : null}
        <textarea
          ref={area}
          value={text}
          disabled={sending}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length > 0) {
              e.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (
              e.key === "ArrowUp" &&
              canRecall(
                { ...e, composing: e.nativeEvent.isComposing },
                e.currentTarget,
                caretOnFirstVisualLine(e.currentTarget),
              )
            ) {
              e.preventDefault();
              void queue.recall();
              return;
            }
            // On a touchscreen, Return is a new line; the send button sends.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touch) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            asleep
              ? `${nibblet.name} is asleep. Send a message to wake them…`
              : `Message ${nibblet.name}…`
          }
          className="block max-h-56 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={picker}
            type="file"
            disabled={sending || queue.editing !== null}
            multiple
            hidden
            onChange={(e) => {
              add([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            disabled={sending || queue.editing !== null}
            onClick={() => picker.current?.click()}
            className="flex size-7 items-center justify-center rounded-full text-dim hover:bg-hover hover:text-text"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="size-4" />
          </button>
          <ModelPicker
            catalogue={catalogue}
            value={{ harness: nibblet.harness, model: nibblet.model }}
            onChange={(choice, option) =>
              void connection.client.nibblets.update({
                id: nibblet.id,
                harness: choice.harness,
                model: choice.model,
                effort:
                  option.efforts.length === 0 || option.efforts.includes(nibblet.effort)
                    ? nibblet.effort
                    : option.defaultEffort,
              })
            }
          />
          <EffortMenu
            model={model}
            value={nibblet.effort}
            onChange={(effort) =>
              void connection.client.nibblets.update({ id: nibblet.id, effort })
            }
          />
          <div className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={() => void connection.client.nibblets.interrupt({ id: nibblet.id })}
              className="flex size-7 items-center justify-center rounded-full bg-text text-bg hover:opacity-80"
              aria-label="Stop"
              title="Stop"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            className={cn(
              "flex h-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-text transition-opacity hover:bg-accent-hover disabled:opacity-30",
              running || queue.editing ? "px-3" : "w-7",
            )}
            aria-label={queue.editing ? "Save queued message" : running ? "Queue send" : "Send"}
            title={uploading ? "Waiting for uploads…" : "Send (Enter)"}
          >
            {running || queue.editing ? (
              <span className="px-1 text-xs">{queue.editing ? "Save" : "Queue"}</span>
            ) : (
              <ArrowUp className="size-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Attachment {
  key: string;
  file: File;
  /** A local preview for images, until it's sent. */
  preview: string | null;
  progress: number;
  ref: FileRef | null;
  error: string | null;
}

/**
 * Files waiting to go with the next message: each starts uploading as soon
 * as it's added, from the picker, a paste, or a drop anywhere on the page.
 */
function useAttachments(connection: ServerConnection, nibbletId: string, enabled: boolean) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);
  const acceptsFiles = useRef(enabled);
  acceptsFiles.current = enabled;

  const update = (key: string, patch: Partial<Attachment>) =>
    setAttachments((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const add = (files: File[]) => {
    if (!acceptsFiles.current) return;
    for (const file of files) {
      const key = `a${counter.current++}`;
      const preview = isImage(file.type) ? URL.createObjectURL(file) : null;
      setAttachments((list) => [
        ...list,
        { key, file, preview, progress: 0, ref: null, error: null },
      ]);
      connection
        .upload(nibbletId, file, (progress) => update(key, { progress }))
        .then(
          (ref) => update(key, { ref, progress: 1 }),
          (err: unknown) =>
            update(key, { error: err instanceof Error ? err.message : String(err) }),
        );
    }
  };

  const remove = (key: string) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return list.filter((a) => a.key !== key);
    });

  const clear = () => setAttachments([]);

  // Drag files anywhere over the page to attach them to this nibblet.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      add([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  });

  return { attachments, add, remove, clear, dragging };
}

function AttachmentChip({
  attachment: a,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const busy = a.ref === null && a.error === null;
  return (
    <div
      className={cn(
        "relative flex items-center gap-2 overflow-hidden rounded-xl border bg-surface pr-1 text-xs",
        a.error ? "border-danger/50" : "border-line",
        a.preview ? "pl-1" : "pl-2.5",
      )}
      title={a.error ?? a.file.name}
    >
      {a.preview ? (
        <img src={a.preview} alt="" className="size-9 rounded-lg object-cover" />
      ) : (
        <FileTypeIcon mime={a.file.type} className="text-dim" />
      )}
      <div className="flex max-w-40 min-w-0 flex-col py-1">
        <span className="truncate font-medium">{a.file.name}</span>
        <span className={cn("truncate text-2xs", a.error ? "text-danger" : "text-faint")}>
          {a.error ??
            (busy ? `Uploading ${Math.round(a.progress * 100)}%` : formatBytes(a.file.size))}
        </span>
      </div>
      {busy ? <Loader2 className="size-3.5 animate-spin text-faint" /> : null}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-1 text-faint hover:bg-hover hover:text-text"
        aria-label={`Remove ${a.file.name}`}
      >
        <X className="size-3" />
      </button>
      {busy ? (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-deep">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${a.progress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
