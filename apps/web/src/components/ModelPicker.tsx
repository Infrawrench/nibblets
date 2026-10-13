import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { HarnessId, harnesses, type ModelOption } from "@nibblet/protocol";
import { HarnessIcon } from "./HarnessIcon.tsx";
import { cn } from "../lib/cn.ts";

export interface ModelChoice {
  harness: HarnessId;
  model: string;
}

/**
 * The model picker, after T3 Code's: a rail of harnesses on the left, and a
 * searchable list of that harness's models on the right. Searching looks
 * across every harness.
 */
export function ModelPicker({
  value,
  onChange,
  className,
}: {
  value: ModelChoice;
  onChange: (choice: ModelChoice, model: ModelOption) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<HarnessId>(value.harness);
  const [query, setQuery] = useState("");
  const current = harnesses[value.harness].models.find((m) => m.id === value.model);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return harnesses[rail].models.map((model) => ({ harness: rail, model }));
    return HarnessId.options.flatMap((h) =>
      harnesses[h].models
        .filter((m) => `${m.label} ${m.id} ${harnesses[h].label}`.toLowerCase().includes(q))
        .map((model) => ({ harness: h, model })),
    );
  }, [rail, query]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setRail(value.harness);
          setQuery("");
        }
      }}
    >
      <Popover.Trigger
        className={cn(
          "flex h-6 max-w-56 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-dim hover:bg-hover hover:text-text",
          className,
        )}
      >
        <HarnessIcon harness={value.harness} className="size-3.5" />
        <span className="truncate">{current?.label ?? value.model}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="flex max-h-86 w-[min(92vw,360px)] overflow-hidden rounded-xl border border-edge bg-panel shadow-float transition-[opacity,transform] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <div className="flex w-11 shrink-0 flex-col items-center gap-1 bg-deep/60 py-2">
              {HarnessId.options.map((h) => (
                <button
                  key={h}
                  type="button"
                  title={harnesses[h].label}
                  aria-label={harnesses[h].label}
                  onClick={() => {
                    setRail(h);
                    setQuery("");
                  }}
                  className={cn(
                    "relative flex size-8 items-center justify-center rounded-md hover:bg-hover",
                    rail === h && !query && "bg-active",
                  )}
                >
                  {rail === h && !query ? (
                    <span className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full bg-accent" />
                  ) : null}
                  <HarnessIcon harness={h} className="size-4.5" />
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col border-l border-line bg-panel">
              <div className="flex h-9 items-center gap-2 border-b border-line px-2.5">
                <Search className="size-3.5 text-faint" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models…"
                  className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                />
              </div>
              {!query ? (
                <div className="px-3 pt-2 pb-1 text-2xs text-faint">
                  {harnesses[rail].description}
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {rows.length === 0 ? (
                  <div className="p-3 text-xs text-faint">No models match.</div>
                ) : null}
                {rows.map(({ harness, model }) => {
                  const selected = harness === value.harness && model.id === value.model;
                  return (
                    <button
                      key={`${harness}:${model.id}`}
                      type="button"
                      onClick={() => {
                        onChange({ harness, model: model.id }, model);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover",
                        selected && "bg-accent-soft/60",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <span className="truncate">{model.label}</span>
                          {model.isNew ? (
                            <span className="rounded bg-accent/15 px-1 text-[9px] font-semibold tracking-wide text-accent uppercase">
                              New
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-1 truncate text-2xs text-faint">
                          {query ? (
                            <>
                              <HarnessIcon harness={harness} className="size-3" />
                              {harnesses[harness].label} ·{" "}
                            </>
                          ) : null}
                          {model.description}
                        </span>
                      </span>
                      {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
