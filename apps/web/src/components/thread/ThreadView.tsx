import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  GitBranch,
  Globe,
  HeartPulse,
  Info,
  Loader2,
  Wrench,
  X,
} from "lucide-react";
import type { Nibblet, StoredItem, ThreadItemOf, TurnSource } from "@nibblet/protocol";
import { buildTimeline, sourceLabels, type TimelineEntry } from "../../lib/thread.ts";
import { clockTime } from "../../lib/time.ts";
import { cn } from "../../lib/cn.ts";
import { Hamster } from "../hamster/Hamster.tsx";

export function ThreadView({
  items,
  server,
  nibblets,
}: {
  items: readonly StoredItem[];
  server: string;
  nibblets: readonly Nibblet[];
}) {
  const timeline = buildTimeline(items);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the bottom while new items arrive, unless the reader scrolled up.
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
        {timeline.length === 0 ? (
          <div className="py-16 text-center text-sm text-faint">Nothing here yet. Say hello.</div>
        ) : null}
        {timeline.map((entry) => (
          <Entry key={entry.key} entry={entry} server={server} nibblets={nibblets} />
        ))}
      </div>
    </div>
  );
}

function Entry({
  entry,
  server,
  nibblets,
}: {
  entry: TimelineEntry;
  server: string;
  nibblets: readonly Nibblet[];
}) {
  switch (entry.kind) {
    case "quiet":
      return (
        <div className="flex items-center gap-1.5 self-center text-2xs text-faint">
          <SourceIcon source={entry.source} />
          {sourceLabels[entry.source]}: nothing to report · {clockTime(entry.at)}
        </div>
      );
    case "trigger":
      return <Trigger item={entry.item} />;
    case "item": {
      const item = entry.item;
      switch (item.type) {
        case "user_message":
          return (
            <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-base whitespace-pre-wrap">
              {item.text}
            </div>
          );
        case "assistant_message":
          return (
            <div className={cn("prose-chat", item.streaming && "streaming")}>
              <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
            </div>
          );
        case "reasoning":
          return <Reasoning item={item} />;
        case "tool_call":
          return <ToolCall item={item} />;
        case "subagent":
          return (
            <Subagent
              item={item}
              server={server}
              child={nibblets.find((n) => n.id === item.childId)}
            />
          );
        case "notice":
          return <Notice item={item} />;
        case "turn":
          return null;
      }
    }
  }
}

function SourceIcon({ source }: { source: TurnSource }) {
  const cls = "size-3 shrink-0";
  switch (source) {
    case "heartbeat":
      return <HeartPulse className={cls} />;
    case "schedule":
      return <CalendarClock className={cls} />;
    case "subagent":
      return <GitBranch className={cls} />;
    default:
      return <Info className={cls} />;
  }
}

function Trigger({ item }: { item: ThreadItemOf<"user_message"> }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="flex max-w-full flex-col items-center gap-1 self-center rounded-md px-2 py-0.5 text-2xs text-faint hover:bg-hover"
    >
      <span className="flex items-center gap-1.5">
        <SourceIcon source={item.source} />
        {sourceLabels[item.source]} · {clockTime(item.createdAt)}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </span>
      {open ? (
        <span className="max-w-[36rem] text-left whitespace-pre-wrap text-dim">{item.text}</span>
      ) : null}
    </button>
  );
}

function Reasoning({ item }: { item: ThreadItemOf<"reasoning"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-faint hover:text-dim"
      >
        <Brain className="size-3.5" />
        {item.streaming ? <span className="animate-pulse">Thinking…</span> : "Thought"}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="mt-1 ml-2 border-l-2 border-line pl-3 text-xs whitespace-pre-wrap text-dim">
          {item.text}
        </div>
      ) : null}
    </div>
  );
}

function toolIcon(item: ThreadItemOf<"tool_call">) {
  if (item.server === "computer") return <Globe />;
  if (item.name.startsWith("memory")) return <Brain />;
  if (item.name.startsWith("schedule") || item.name.startsWith("heartbeat")) return <Clock />;
  if (item.name.includes("subagent")) return <GitBranch />;
  return <Wrench />;
}

/** One line of the tool's input: its first string argument, or nothing. */
function summarise(input: ThreadItemOf<"tool_call">["input"]): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return typeof input === "string" ? input : "";
  }
  for (const value of Object.values(input)) if (typeof value === "string") return value;
  return "";
}

function ToolCall({ item }: { item: ThreadItemOf<"tool_call"> }) {
  const [open, setOpen] = useState(false);
  const summary = summarise(item.input);
  return (
    <div className="rounded-lg border border-line bg-panel text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0"
      >
        <span className="flex size-5 items-center justify-center rounded bg-deep text-dim">
          {toolIcon(item)}
        </span>
        <span className="font-medium">{item.name.replace(/_/g, " ")}</span>
        <span className="min-w-0 flex-1 truncate text-faint">{summary}</span>
        {item.status === "running" ? (
          <Loader2 className="animate-spin text-working" />
        ) : item.status === "error" ? (
          <X className="text-danger" />
        ) : (
          <Check className="text-ok" />
        )}
        <ChevronRight className={cn("text-faint transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-line p-2">
          <pre className="max-h-48 overflow-auto rounded bg-deep p-2 font-mono text-2xs whitespace-pre-wrap">
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {item.output ? (
            <pre className="max-h-64 overflow-auto rounded bg-deep p-2 font-mono text-2xs whitespace-pre-wrap">
              {item.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Subagent({
  item,
  server,
  child,
}: {
  item: ThreadItemOf<"subagent">;
  server: string;
  child: Nibblet | undefined;
}) {
  return (
    <Link
      to="/n/$server/$id"
      params={{ server, id: item.childId }}
      className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-2.5 py-2 hover:bg-hover"
    >
      {child ? (
        <Hamster look={child.look} size={28} status={child.status} />
      ) : (
        <GitBranch className="size-4 text-dim" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium">{child?.name ?? "Sub-agent"}</span>
        <span className="truncate text-2xs text-dim">{item.result ?? item.task}</span>
      </span>
      <span
        className={cn(
          "text-2xs font-medium",
          item.status === "running"
            ? "text-working"
            : item.status === "error"
              ? "text-danger"
              : "text-ok",
        )}
      >
        {item.status === "running" ? "Working" : item.status === "error" ? "Failed" : "Done"}
      </span>
    </Link>
  );
}

function Notice({ item }: { item: ThreadItemOf<"notice"> }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
        item.level === "error" && "bg-danger/10 text-danger",
        item.level === "warning" && "bg-warning/10 text-warning",
        item.level === "info" && "bg-hover text-dim",
      )}
    >
      {item.level === "info" ? <Info /> : <AlertTriangle />}
      <span>{item.text}</span>
    </div>
  );
}
