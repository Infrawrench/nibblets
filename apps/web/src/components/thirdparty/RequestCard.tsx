import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "lucide-react";
import {
  isWebUrl,
  type ThirdPartyAction,
  type ThirdPartyAnswer,
  type ThirdPartyRequest,
} from "@nibblets/protocol";
import { relativeTime } from "../../lib/time.ts";
import { cn } from "../../lib/cn.ts";
import { MarkdownLink } from "../thread/ThreadView.tsx";
import { Button } from "../ui/Button.tsx";
import { Textarea } from "../ui/Field.tsx";

/** What pressing it will do beyond the third party, said before it's pressed. */
const effectNote = {
  ships: "This goes out now: it sends, publishes or spends.",
  answers: "It carries on with your answer.",
  none: null,
} as const;

/**
 * Something a third party is waiting on the person for, drawn from its
 * actions alone: the main one as the primary button, the rest beside it.
 * One that asks for something, or that sends, publishes or spends, opens
 * a step to fill it in or confirm first.
 */
export function RequestCard({
  request,
  name,
  onAct,
}: {
  request: ThirdPartyRequest;
  /** The third party's name, for the link to its own app. */
  name: string;
  onAct: (action: string, answer: ThirdPartyAnswer) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<ThirdPartyAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = request.actions.find((a) => a.primary);
  const others = request.actions.filter((a) => !a.primary);

  const take = async (action: ThirdPartyAction, answer: ThirdPartyAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await onAct(action.id, answer);
      setChosen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const press = (action: ThirdPartyAction) => {
    if (action.input.kind === "none" && action.effect !== "ships") void take(action, {});
    else setChosen(action);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{request.title}</span>
        {request.priority === "high" ? (
          <span className="shrink-0 text-2xs text-warning">High priority</span>
        ) : null}
      </div>
      {request.body ? (
        <div className="prose-chat text-sm">
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
            {request.body}
          </Markdown>
        </div>
      ) : null}
      {request.details.map((d) => (
        <details key={d.label} className="text-xs">
          <summary className="cursor-pointer text-dim select-none hover:text-text">
            {d.label}
          </summary>
          <div className="mt-1 max-h-60 overflow-y-auto rounded-md bg-deep px-2 py-1.5 whitespace-pre-wrap">
            {d.text}
          </div>
        </details>
      ))}
      {request.goesAheadAt ? (
        <span className="text-2xs text-faint">
          Goes ahead by itself {relativeTime(request.goesAheadAt)} unless you act first.
        </span>
      ) : null}
      {chosen ? (
        <ActionStep
          action={chosen}
          busy={busy}
          onCancel={() => {
            setChosen(null);
            setError(null);
          }}
          onConfirm={(answer) => void take(chosen, answer)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {primary ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => press(primary)}>
              {primary.label}
            </Button>
          ) : null}
          {others.map((a) => (
            <Button key={a.id} size="sm" disabled={busy} onClick={() => press(a)}>
              {a.label}
            </Button>
          ))}
          {request.open && isWebUrl(request.open.url) ? (
            <a
              href={request.open.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Opens ${name}`}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-hover",
                primary ? "text-dim hover:text-text" : "font-medium text-accent",
              )}
            >
              {request.open.label}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      )}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** Filling in what an action asks for, and confirming one that goes out. */
function ActionStep({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: ThirdPartyAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (answer: ThirdPartyAnswer) => void;
}) {
  const [text, setText] = useState("");
  const [option, setOption] = useState<string | null>(null);
  const input = action.input;
  const ready =
    input.kind === "choice"
      ? option !== null
      : input.kind === "text" && input.required
        ? text.trim().length > 0
        : true;
  const note = effectNote[action.effect];
  return (
    <div className="flex flex-col gap-2 rounded-md bg-deep px-2.5 py-2">
      {input.kind === "text" ? (
        <Textarea
          autoFocus
          rows={3}
          value={text}
          placeholder={input.placeholder ?? undefined}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
      {input.kind === "choice" ? (
        <div className="flex flex-col gap-1">
          {input.options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`choice-${action.id}`}
                checked={option === o.value}
                onChange={() => setOption(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      ) : null}
      {note ? (
        <p className={cn("text-xs", action.effect === "ships" ? "text-warning" : "text-dim")}>
          {note}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <Button
          variant={action.effect === "ships" ? "primary" : "secondary"}
          size="sm"
          disabled={busy || !ready}
          onClick={() =>
            onConfirm({
              ...(text.trim() ? { text: text.trim() } : {}),
              ...(option !== null ? { option } : {}),
            })
          }
        >
          {busy ? "Working…" : action.label}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
