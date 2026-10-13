import { useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { findModel, type Nibblet } from "@nibblet/protocol";
import { ModelPicker } from "../ModelPicker.tsx";
import { EffortMenu } from "../EffortMenu.tsx";
import { cn } from "../../lib/cn.ts";
import type { ServerConnection } from "../../lib/connection.ts";

/** The floating message card at the foot of a thread. */
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
  const area = useRef<HTMLTextAreaElement>(null);
  const model = findModel(nibblet.harness, nibblet.model);
  const asleep = nibblet.status === "stopped";

  // Clears straight away: the message shows up in the thread as soon as the
  // server has it, and comes back to the box only if sending failed.
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setText("");
    if (area.current) area.current.style.height = "auto";
    try {
      await connection.client.nibblets.send({ id: nibblet.id, text: message });
    } catch {
      setText((current) => current || message);
    } finally {
      setSending(false);
      area.current?.focus();
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
      <div className="pointer-events-auto mx-auto max-w-[46rem] rounded-3xl border border-black/8 bg-surface/85 shadow-float backdrop-blur-md transition-colors focus-within:border-accent/50 dark:border-white/8 dark:focus-within:border-accent/50">
        <textarea
          ref={area}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          <ModelPicker
            value={{ harness: nibblet.harness, model: nibblet.model }}
            onChange={(choice, option) =>
              void connection.client.nibblets.update({
                id: nibblet.id,
                harness: choice.harness,
                model: choice.model,
                effort: option.efforts.includes(nibblet.effort)
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
          ) : (
            <button
              type="button"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
              className={cn(
                "flex size-7 items-center justify-center rounded-full bg-accent text-accent-text transition-opacity hover:bg-accent-hover disabled:opacity-30",
              )}
              aria-label="Send"
              title="Send (Enter)"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
