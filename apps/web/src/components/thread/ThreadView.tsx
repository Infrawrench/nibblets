import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import Markdown from "react-markdown";
import { isSafeLink } from "../../lib/links.ts";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  GitBranch,
  Globe,
  HeartPulse,
  Info,
  Loader2,
  ShieldAlert,
  Wrench,
  LocateFixed,
  MapPin,
  X,
} from "lucide-react";
import type { Nibblet, StoredItem, ThreadItemOf, TurnSource } from "@nibblet/protocol";
import { z } from "zod";
import { openPanel } from "../../lib/panels.ts";
import { buildTimeline, sourceLabels, type TimelineEntry } from "../../lib/thread.ts";
import { clockTime } from "../../lib/time.ts";
import { cn } from "../../lib/cn.ts";
import { SharedFileEntry, UserAttachments } from "../files/Files.tsx";
import { Hamster } from "../hamster/Hamster.tsx";
import { Button } from "../ui/Button.tsx";
import { Input } from "../ui/Field.tsx";

/** Answers a gated tool call the nibblet is waiting on. */
export type DecideFn = (approvalId: string, approve: boolean, reason?: string) => Promise<void>;

/** Answers the nibblet asking where its person is: with this device's location, or not. */
export type LocationFn = (requestId: string, share: boolean) => Promise<void>;

export function ThreadView({
  items,
  server,
  nibblets,
  onDecide,
  onResume,
  onLocation,
}: {
  items: readonly StoredItem[];
  server: string;
  nibblets: readonly Nibblet[];
  onDecide?: DecideFn;
  onLocation?: LocationFn;
  /** "Try now" on a usage-limit wait. */
  onResume?: () => Promise<void>;
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
          <Entry
            key={entry.key}
            entry={entry}
            server={server}
            nibblets={nibblets}
            onDecide={onDecide}
            onResume={onResume}
            onLocation={onLocation}
          />
        ))}
      </div>
    </div>
  );
}

function Entry({
  entry,
  server,
  nibblets,
  onDecide,
  onResume,
  onLocation,
}: {
  entry: TimelineEntry;
  server: string;
  nibblets: readonly Nibblet[];
  onDecide?: DecideFn;
  onLocation?: LocationFn;
  onResume?: () => Promise<void>;
}) {
  switch (entry.kind) {
    case "quiet":
      return (
        <Quiet entry={entry}>
          {entry.entries.map((inner) => (
            <Entry
              key={inner.key}
              entry={inner}
              server={server}
              nibblets={nibblets}
              onDecide={onDecide}
              onResume={onResume}
              onLocation={onLocation}
            />
          ))}
        </Quiet>
      );
    case "trigger":
      return <Trigger item={entry.item} />;
    case "item": {
      const item = entry.item;
      switch (item.type) {
        case "user_message":
          return (
            <div className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
              {item.attachments?.length ? (
                <UserAttachments server={server} files={item.attachments} />
              ) : null}
              {item.text ? (
                <div className="rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 text-base whitespace-pre-wrap">
                  {item.text}
                </div>
              ) : null}
            </div>
          );
        case "assistant_message":
          return (
            <div className={cn("prose-chat", item.streaming && "streaming")}>
              <Markdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                {item.text}
              </Markdown>
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
        case "file":
          return <SharedFileEntry server={server} item={item} />;
        case "notice":
          return <Notice item={item} />;
        case "approval":
          return isCardVerify(item) ? (
            <CardVerify item={item} onDecide={onDecide} />
          ) : (
            <Approval item={item} onDecide={onDecide} />
          );
        case "location_request":
          return <LocationRequest item={item} onLocation={onLocation} />;
        case "limit_wait":
          return <LimitWait item={item} onResume={onResume} />;
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

/** A turn the user didn't start that had nothing to report; expands to what it did. */
function Quiet({
  entry,
  children,
}: {
  entry: Extract<TimelineEntry, { kind: "quiet" }>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const calls = entry.entries.filter(
    (e) => e.kind === "item" && e.item.type === "tool_call",
  ).length;
  const label = (
    <>
      <SourceIcon source={entry.source} />
      {sourceLabels[entry.source]}: nothing to report
      {calls > 0 ? ` · ${calls} tool ${calls === 1 ? "call" : "calls"}` : ""} ·{" "}
      {clockTime(entry.at)}
    </>
  );
  if (entry.entries.length === 0)
    return <div className="flex items-center gap-1.5 self-center text-2xs text-faint">{label}</div>;
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 self-center rounded-md px-2 py-0.5 text-2xs text-faint hover:bg-hover"
      >
        {label}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-l-2 border-line pl-3">{children}</div>
      ) : null}
    </div>
  );
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

const subscriptionNames = { anthropic: "Claude", openai: "ChatGPT" } as const;

/** Waiting out a usage limit or a spent budget: when it carries on, and a way to try sooner. */
function LimitWait({
  item,
  onResume,
}: {
  item: ThreadItemOf<"limit_wait">;
  onResume?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const which = item.provider ? `your ${subscriptionNames[item.provider]} subscription's` : "the";
  const text =
    item.reason === "budget"
      ? item.status === "waiting"
        ? `Spent its monthly budget. Carrying on when the month turns, or raise the budget in its settings.`
        : item.status === "resumed"
          ? "Spent its monthly budget, then carried on."
          : "Stopped waiting for its monthly budget."
      : item.status === "waiting"
        ? `Hit ${which} usage limit. Carrying on by itself at ${clockTime(item.until)}.`
        : item.status === "resumed"
          ? `Hit ${which} usage limit, then carried on.`
          : `Stopped waiting for ${which} usage limit.`;
  return (
    <div className="flex items-center gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-warning [&>svg]:size-3.5 [&>svg]:shrink-0">
      <Clock />
      <span className="flex-1">{text}</span>
      {item.status === "waiting" && onResume ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onResume();
            } finally {
              setBusy(false);
            }
          }}
        >
          Try now
        </Button>
      ) : null}
    </div>
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

/** The nibblet asking where its person is: Share / Not now while it waits, then what happened. */
function LocationRequest({
  item,
  onLocation,
}: {
  item: ThreadItemOf<"location_request">;
  onLocation?: LocationFn;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (share: boolean) => {
    if (!onLocation) return;
    setBusy(true);
    setError(null);
    try {
      await onLocation(item.id, share);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const text = {
    pending: "Asking where you are",
    shared: item.place
      ? `Your device said where you are: ${item.place}`
      : "Your device said where you are",
    declined: "You didn't share where you are",
    unanswered: "Asked where you are, but no device answered",
  }[item.status];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-xs",
        item.status === "pending" ? "border border-accent/50 bg-accent/5" : "bg-hover text-dim",
      )}
    >
      <MapPin className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      {item.status === "pending" && onLocation ? (
        <span className="flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
            Not now
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void answer(true)}>
            <LocateFixed />
            {busy ? "Finding you…" : "Share"}
          </Button>
        </span>
      ) : null}
      {error ? <span className="basis-full text-danger">{error}</span> : null}
    </div>
  );
}

const approvalOutcome: Record<
  Exclude<ThreadItemOf<"approval">["status"], "pending">,
  { label: string; className: string }
> = {
  approved: { label: "Approved", className: "text-ok" },
  denied: { label: "Declined", className: "text-danger" },
  expired: { label: "Not answered in time", className: "text-faint" },
};

/** A gated tool call: what it wants to do, and Approve / Decline while it waits. */
function Approval({ item, onDecide }: { item: ThreadItemOf<"approval">; onDecide?: DecideFn }) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [showInput, setShowInput] = useState(item.status === "pending");
  const pending = item.status === "pending";
  const decide = async (approve: boolean) => {
    if (!onDecide) return;
    setBusy(true);
    try {
      await onDecide(item.id, approve, approve ? undefined : reason.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };
  const server = item.server.replace(/^host_/, "");
  return (
    <div
      className={cn(
        "rounded-lg border text-xs",
        pending ? "border-warning/60 bg-warning/5" : "border-line bg-panel",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <ShieldAlert className={cn("size-4 shrink-0", pending ? "text-warning" : "text-faint")} />
        <span className="min-w-0 flex-1">
          {pending ? "Wants to use " : "Asked to use "}
          <span className="font-medium">{item.tool.replace(/_/g, " ")}</span>
          <span className="text-faint"> on {server}</span>
        </span>
        {item.status === "pending" ? null : (
          <span className={approvalOutcome[item.status].className}>
            {approvalOutcome[item.status].label}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowInput((o) => !o)}
          className="text-faint hover:text-text"
          aria-label={showInput ? "Hide details" : "Show details"}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", showInput && "rotate-90")} />
        </button>
      </div>
      {showInput ? (
        <pre className="mx-2.5 mb-2 max-h-56 overflow-auto rounded bg-deep p-2 font-mono text-2xs whitespace-pre-wrap">
          {JSON.stringify(item.input, null, 2)}
        </pre>
      ) : null}
      {!pending && item.reason ? (
        <div className="px-2.5 pb-2 text-faint">Reason: {item.reason}</div>
      ) : null}
      {pending && onDecide ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-2.5 py-2">
          {declining ? (
            <>
              <Input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why not? (optional, the nibblet sees this)"
                className="h-6 min-w-0 flex-1 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void decide(false);
                }}
              />
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(false)}>
                Decline
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeclining(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(true)}>
                <Check />
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setDeclining(true)}
              >
                <X />
                Decline
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What a nibblet's `card_verify` asks its person to do. */
const CardVerifyInput = z.object({ display: z.string(), merchant: z.string(), asks: z.string() });

function isCardVerify(item: ThreadItemOf<"approval">): boolean {
  return (
    item.server === "nibblet" &&
    item.tool === "card_verify" &&
    CardVerifyInput.safeParse(item.input).success
  );
}

const verifyOutcome: typeof approvalOutcome = {
  approved: { label: "Verified", className: "text-ok" },
  denied: { label: "Not verified", className: "text-danger" },
  expired: { label: "Not done in time", className: "text-faint" },
};

/**
 * A checkout asking to verify a card payment (3-D Secure), which the
 * nibblet leaves to its person: they do it in its browser, so the code
 * never reaches the nibblet, then say whether it's done.
 */
function CardVerify({ item, onDecide }: { item: ThreadItemOf<"approval">; onDecide?: DecideFn }) {
  const [busy, setBusy] = useState(false);
  const input = CardVerifyInput.safeParse(item.input);
  if (!input.success) return null;
  const { display, merchant, asks } = input.data;
  const pending = item.status === "pending";
  const decide = async (done: boolean) => {
    if (!onDecide) return;
    setBusy(true);
    try {
      await onDecide(item.id, done);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(
        "rounded-lg border text-xs",
        pending ? "border-warning/60 bg-warning/5" : "border-line bg-panel",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <CreditCard
          className={cn("mt-px size-4 shrink-0", pending ? "text-warning" : "text-faint")}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>
            {pending ? "Needs you to verify a payment to " : "Asked you to verify a payment to "}
            <span className="font-medium">{merchant}</span>
            <span className="text-faint"> on {display}</span>
          </span>
          <span className="text-dim">{asks}</span>
          {pending ? (
            <span className="text-faint">
              Do it in its browser yourself, so the code never goes to the nibblet, then say whether
              it worked.
            </span>
          ) : null}
        </span>
        {item.status === "pending" ? null : (
          <span className={verifyOutcome[item.status].className}>
            {verifyOutcome[item.status].label}
          </span>
        )}
      </div>
      {!pending && item.reason ? (
        <div className="px-2.5 pb-2 text-faint">Reason: {item.reason}</div>
      ) : null}
      {pending && onDecide ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-2.5 py-2">
          <Button size="sm" variant="secondary" onClick={() => openPanel("browser")}>
            <Globe />
            Open its browser
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(true)}>
            <Check />
            Done
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}>
            <X />
            Couldn't
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Links in a nibblet's replies open in a new tab, never in place of the app,
 * and only to web and mail addresses; anything else is shown as text.
 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !isSafeLink(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
